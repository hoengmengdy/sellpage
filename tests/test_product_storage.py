"""Storage regression checks; all catalog writes use temporary files or a fake Blob client.

Run: python -m unittest discover -s tests -v
"""
import io
import importlib.metadata
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import httpx

# Import without filesystem initialization or access to real cloud credentials.
with patch.dict(os.environ, {"VERCEL": "1", "BLOB_READ_WRITE_TOKEN": ""}):
    import admin


class ProductStorageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        catalog = root / "products.json"
        catalog.write_text("[]", encoding="utf-8")
        self.catalog = catalog
        self.blob = Mock()
        self.blob.list_objects.return_value = SimpleNamespace(blobs=[])
        self.blob.put.return_value = SimpleNamespace(pathname="uploads/test.png")
        patches = [
            patch.multiple(
                admin, DATA_DIR=root, DATA_FILE=catalog, UPLOAD_DIR=root / "uploads",
                STATIC_PRODUCTS_FILE=root / "products-data.js", IS_VERCEL=True, BLOB_ENABLED=True,
            ),
            patch.object(admin, "blob_client", return_value=self.blob),
            patch.object(admin.app.logger, "exception"),
            patch.object(admin.app.logger, "warning"),
            patch.dict(admin.app.config, TESTING=True, SECRET_KEY="isolated-storage-test"),
        ]
        for replacement in patches:
            replacement.start()
            self.addCleanup(replacement.stop)
        self.client = admin.app.test_client()
        with self.client.session_transaction() as session:
            session["admin_authenticated"] = True
        self.form = {
            "name": "Page for business", "followers": "3K", "category": "page",
            "price": "24.60", "oldPrice": "30", "discount": "", "status": "available",
            "description": "Original product description", "facebook_url": "", "telegram_url": "",
        }

    def test_add_page_renders_when_storage_is_unconfigured(self):
        with patch.object(admin, "BLOB_ENABLED", False), patch.object(Path, "mkdir", side_effect=PermissionError("read-only")):
            response = self.client.get("/admin/products/add")
            admin.ensure_storage()
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Product storage is not connected", response.data)

    def test_missing_storage_returns_form_instead_of_500(self):
        with patch.object(admin, "BLOB_ENABLED", False):
            response = self.client.post("/admin/products/add", data=self.form)
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Connect a private Vercel Blob store", response.data)
        self.assertIn(b'value="Page for business"', response.data)
        self.assertEqual(json.loads(self.catalog.read_text()), [])

    def test_blob_save_failure_preserves_form_without_exposing_sdk_error(self):
        self.blob.put.side_effect = RuntimeError("private-sdk-error-details")
        response = self.client.post("/admin/products/add", data=self.form)
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Product changes could not be saved", response.data)
        self.assertIn(b'value="Page for business"', response.data)
        self.assertIn(b'value="24.60"', response.data)
        self.assertIn(b"Original product description", response.data)
        self.assertNotIn(b"private-sdk-error-details", response.data)
        self.assertEqual(json.loads(self.catalog.read_text()), [])

    def test_blob_upload_failure_returns_form_and_does_not_save_product(self):
        self.blob.put.side_effect = RuntimeError("upload rejected")
        response = self.client.post(
            "/admin/products/add",
            data={**self.form, "image": (io.BytesIO(b"image bytes"), "page.png")},
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"The image could not be uploaded", response.data)
        self.assertIn(b'value="Page for business"', response.data)
        self.assertEqual(self.blob.put.call_count, 1)
        self.assertTrue(self.blob.put.call_args.args[0].startswith("uploads/"))

    def test_read_failure_blocks_writes_using_a_stale_fallback_catalog(self):
        self.blob.list_objects.side_effect = RuntimeError("storage unavailable")
        response = self.client.post("/admin/products/add", data=self.form)
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Could not read saved products", response.data)
        self.blob.put.assert_not_called()
        self.assertEqual(admin.load_products(), [])

    def test_successful_cloud_creation_keeps_prices_and_private_image_route(self):
        response = self.client.post(
            "/admin/products/add",
            data={**self.form, "image": (io.BytesIO(b"image bytes"), "page.png")},
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.location.endswith("/admin/products"))
        upload, save = self.blob.put.call_args_list
        self.assertEqual(upload.kwargs["access"], "private")
        self.assertEqual(save.kwargs["access"], "private")
        saved = json.loads(save.args[1])[0]
        self.assertEqual(saved["price"], 24.6)
        self.assertEqual(saved["oldPrice"], 30)
        self.assertEqual(saved["discount"], "-18%")
        self.assertEqual(saved["image"], "/media/uploads/test.png")
        self.assertEqual(saved["status"], "available")

    def test_edit_and_delete_handle_cloud_write_failure(self):
        self.catalog.write_text(json.dumps([{
            **self.form, "id": 1, "price": 24.6, "oldPrice": 30,
            "created_at": "2026-10-22 09:00:00",
        }]), encoding="utf-8")
        self.blob.put.side_effect = RuntimeError("write rejected")
        edited = self.client.post("/admin/products/edit/1", data=self.form)
        self.assertEqual(edited.status_code, 200)
        self.assertIn(b"Product changes could not be saved", edited.data)
        deleted = self.client.post("/admin/products/delete/1", follow_redirects=True)
        self.assertEqual(deleted.status_code, 200)
        self.assertIn(b"Product changes could not be saved", deleted.data)
        self.assertEqual(len(json.loads(self.catalog.read_text())), 1)

    def test_local_creation_still_persists_the_catalog_and_snapshot(self):
        with patch.multiple(admin, IS_VERCEL=False, BLOB_ENABLED=False):
            response = self.client.post("/admin/products/add", data=self.form)
        self.assertEqual(response.status_code, 302)
        saved = json.loads(self.catalog.read_text())
        self.assertEqual(saved[0]["name"], self.form["name"])
        self.assertTrue(admin.STATIC_PRODUCTS_FILE.read_text().startswith("window.STOREFRONT_PRODUCTS="))

    def test_authentication_is_still_required(self):
        response = admin.app.test_client().get("/admin/products/add")
        self.assertEqual(response.status_code, 302)
        self.assertIn("/admin/login", response.location)


class BlobSdkCompatibilityTests(unittest.TestCase):
    def test_real_sdk_reads_catalog_and_writes_products_and_images(self):
        # Mock the HTTP boundary, not BlobClient: SDK import/response changes must fail this test.
        from vercel.blob import BlobClient

        self.assertEqual(importlib.metadata.version("vercel"), "0.10.0")
        client = BlobClient(token="vercel_blob_rw_teststore_secret")
        self.addCleanup(client.close)
        pathname = "data/products-20261022090000-existing.json"
        base = "https://teststore.private.blob.vercel-storage.com/"
        products = [{"id": 7, "name": "Saved product", "followers": "3K", "price": 24.6}]
        writes = []

        def send(http_client, request, **kwargs):
            if request.url.host == "teststore.private.blob.vercel-storage.com":
                return httpx.Response(
                    200, content=json.dumps(products).encode(), request=request,
                    headers={
                        "content-type": "application/json", "etag": "test-etag",
                        "last-modified": "Thu, 22 Oct 2026 09:00:00 GMT",
                        "cache-control": "private, max-age=0",
                    },
                )
            if request.method == "GET":
                return httpx.Response(200, request=request, json={
                    "blobs": [{
                        "pathname": pathname, "url": base + pathname,
                        "downloadUrl": base + pathname + "?download=1", "size": 100,
                        "uploadedAt": "2026-10-22T09:00:00.000Z",
                    }], "hasMore": False, "cursor": None,
                })
            self.assertEqual(request.method, "PUT")
            written_path = request.url.params["pathname"]
            writes.append((written_path, request.read()))
            return httpx.Response(200, request=request, json={
                "pathname": written_path, "url": base + written_path,
                "downloadUrl": base + written_path + "?download=1",
                "contentType": request.headers.get("content-type", "application/octet-stream"),
                "contentDisposition": "inline",
            })

        with patch.object(httpx.Client, "send", send), patch.multiple(admin, BLOB_ENABLED=True, IS_VERCEL=True), patch.object(admin, "blob_client", return_value=client):
            loaded = admin.load_products(for_write=True)
            self.assertEqual(loaded, products)
            loaded.append({"id": 8, "name": "New product", "followers": "1K", "price": 10})
            admin.save_products(loaded)
            self.assertEqual(json.loads(writes[0][1]), loaded)
            with admin.app.test_request_context():
                from werkzeug.datastructures import FileStorage
                image = admin.save_upload(FileStorage(stream=io.BytesIO(b"test image bytes"), filename="page.png"))
            self.assertTrue(image.startswith("/media/uploads/"), image)
            self.assertEqual(writes[1][1], b"test image bytes")


if __name__ == "__main__":
    unittest.main()
