import json
import os
import secrets
from datetime import datetime
from functools import wraps
from pathlib import Path

from flask import Flask, abort, flash, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).resolve().parent
IS_VERCEL = os.getenv("VERCEL") == "1"
DATA_DIR = BASE_DIR / "data"
DATA_FILE = DATA_DIR / "products.json"
STATIC_PRODUCTS_FILE = BASE_DIR / "js" / "products-data.js"
UPLOAD_DIR = BASE_DIR / "static" / "uploads"
ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
CATEGORIES = {
    "page": "ផេក PE",
    "pe": "ផេក Reel",
    "account": "អាខោន Facebook",
    "service": "សេវាកម្ម",
    "other": "ផ្សេងៗ",
}
STATUSES = {"available", "sold", "hidden"}

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "change-this-secret-key")
app.config.update(MAX_CONTENT_LENGTH=10 * 1024 * 1024, UPLOAD_FOLDER=str(UPLOAD_DIR), SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax")
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD_HASH = os.getenv("ADMIN_PASSWORD_HASH") or generate_password_hash(os.getenv("ADMIN_PASSWORD", "admin123"))


@app.after_request
def allow_local_storefront(response):
    """Allow the standalone file:// storefront to read the public product API."""
    if request.path.startswith("/api/products"):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    return response


def ensure_storage():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    if not DATA_FILE.exists():
        save_products([])


def sync_static_products(products):
    # Vercel Functions run from a read-only deployment filesystem. The JSON and
    # generated JavaScript are already bundled by Git, so do not rewrite them
    # while importing the Flask application.
    if IS_VERCEL:
        return
    STATIC_PRODUCTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(products, ensure_ascii=False, separators=(",", ":"))
    temporary = STATIC_PRODUCTS_FILE.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as file:
        file.write(f"window.STOREFRONT_PRODUCTS={payload};\n")
    temporary.replace(STATIC_PRODUCTS_FILE)


def load_products():
    ensure_storage()
    try:
        with DATA_FILE.open("r", encoding="utf-8") as file:
            data = json.load(file)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def save_products(products):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temporary = DATA_FILE.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as file:
        json.dump(products, file, ensure_ascii=False, indent=2)
        file.flush()
        os.fsync(file.fileno())
    temporary.replace(DATA_FILE)
    sync_static_products(products)


def get_product(product_id):
    return next((product for product in load_products() if product.get("id") == product_id), None)


def generate_product_id(products=None):
    products = products if products is not None else load_products()
    return max((int(product.get("id", 0)) for product in products), default=0) + 1


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("admin_authenticated"):
            return redirect(url_for("admin_login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def save_upload(upload):
    if not upload or not upload.filename:
        return None
    if not allowed_file(upload.filename):
        raise ValueError("Invalid image format. Use JPG, JPEG, PNG, or WEBP.")
    original = secure_filename(upload.filename)
    extension = original.rsplit(".", 1)[1].lower()
    filename = f"{datetime.now():%Y%m%d%H%M%S}-{secrets.token_hex(6)}.{extension}"
    upload.save(UPLOAD_DIR / filename)
    return f"/static/uploads/{filename}"


def parse_price(raw_value, label, required=False):
    raw_value = (raw_value or "").strip()
    if not raw_value and not required:
        return None
    try:
        value = float(raw_value)
    except ValueError as exc:
        raise ValueError(f"{label} must be numeric.") from exc
    if value < 0:
        raise ValueError(f"{label} cannot be negative.")
    return round(value, 2)


def product_from_form(existing=None):
    name = request.form.get("name", "").strip()
    followers = request.form.get("followers", "").strip()
    category = request.form.get("category", "").strip()
    status = request.form.get("status", "").strip()
    if not name:
        raise ValueError("Product name is required.")
    if not followers:
        raise ValueError("Follower count is required.")
    if category not in CATEGORIES:
        raise ValueError("Please select a valid category.")
    if status not in STATUSES:
        raise ValueError("Please select a valid status.")
    price = parse_price(request.form.get("price"), "Price", required=True)
    old_price = parse_price(request.form.get("oldPrice"), "Old price")
    discount = request.form.get("discount", "").strip()
    if old_price and old_price > price and not discount:
        discount = f"-{round((old_price - price) / old_price * 100)}%"
    image = save_upload(request.files.get("image")) or (existing or {}).get("image") or "/static/uploads/page-dashboard.png"
    return {
        "name": name,
        "followers": followers,
        "price": price,
        "oldPrice": old_price,
        "discount": discount or None,
        "category": category,
        "description": request.form.get("description", "").strip(),
        "image": image,
        "status": status,
        "facebook_url": request.form.get("facebook_url", "").strip(),
        "telegram_url": request.form.get("telegram_url", "").strip(),
    }


@app.errorhandler(413)
def file_too_large(_error):
    flash("Image is too large. Maximum upload size is 10MB.", "error")
    return redirect(request.referrer or url_for("admin_products"))


@app.get("/")
def index():
    return render_template("index.html")


@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    if session.get("admin_authenticated"):
        return redirect(url_for("admin_dashboard"))
    if request.method == "POST":
        username = request.form.get("username", "")
        password = request.form.get("password", "")
        if secrets.compare_digest(username, ADMIN_USERNAME) and check_password_hash(ADMIN_PASSWORD_HASH, password):
            session.clear()
            session["admin_authenticated"] = True
            session.permanent = True
            flash("Welcome back!", "success")
            return redirect(url_for("admin_dashboard"))
        flash("Invalid username or password.", "error")
    return render_template("admin_login.html")


@app.get("/admin/logout")
@login_required
def admin_logout():
    session.clear()
    flash("You have been logged out.", "success")
    return redirect(url_for("admin_login"))


@app.get("/admin")
@login_required
def admin_dashboard():
    products = load_products()
    stats = {
        "total": len(products),
        "available": sum(p.get("status") == "available" for p in products),
        "sold": sum(p.get("status") == "sold" for p in products),
        "pages": sum(p.get("category") in {"page", "pe"} for p in products),
        "accounts": sum(p.get("category") == "account" for p in products),
        "discounted": sum(bool(p.get("discount")) for p in products),
    }
    recent = sorted(products, key=lambda p: p.get("created_at", ""), reverse=True)[:5]
    return render_template("admin_dashboard.html", stats=stats, recent=recent, categories=CATEGORIES)


@app.get("/admin/products")
@login_required
def admin_products():
    return render_template("admin_products.html", products=load_products(), categories=CATEGORIES)


@app.route("/admin/products/add", methods=["GET", "POST"])
@login_required
def admin_add_product():
    if request.method == "POST":
        try:
            product = product_from_form()
            products = load_products()
            product.update(id=generate_product_id(products), created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
            products.append(product)
            save_products(products)
            flash("Product added successfully.", "success")
            return redirect(url_for("admin_products"))
        except ValueError as error:
            flash(str(error), "error")
    return render_template("admin_add_product.html", product={}, categories=CATEGORIES, statuses=STATUSES)


@app.route("/admin/products/edit/<int:product_id>", methods=["GET", "POST"])
@login_required
def admin_edit_product(product_id):
    products = load_products()
    product = next((item for item in products if item.get("id") == product_id), None)
    if not product:
        flash("Product not found.", "error")
        return redirect(url_for("admin_products"))
    if request.method == "POST":
        try:
            updated = product_from_form(product)
            product.update(updated)
            save_products(products)
            flash("Product updated successfully.", "success")
            return redirect(url_for("admin_products"))
        except ValueError as error:
            flash(str(error), "error")
    return render_template("admin_edit_product.html", product=product, categories=CATEGORIES, statuses=STATUSES)


@app.post("/admin/products/delete/<int:product_id>")
@login_required
def admin_delete_product(product_id):
    products = load_products()
    product = next((item for item in products if item.get("id") == product_id), None)
    if not product:
        flash("Product not found.", "error")
        return redirect(url_for("admin_products"))
    save_products([item for item in products if item.get("id") != product_id])
    flash("Product deleted successfully.", "success")
    return redirect(url_for("admin_products"))


@app.get("/api/products")
def api_products():
    products = [product for product in load_products() if product.get("status") != "hidden"]
    return jsonify(success=True, count=len(products), products=products)


@app.get("/api/products/<int:product_id>")
def api_product(product_id):
    product = get_product(product_id)
    if not product or product.get("status") == "hidden":
        return jsonify(success=False, message="Product not found"), 404
    return jsonify(success=True, product=product)


ensure_storage()
sync_static_products(load_products())

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.getenv("PORT", "5500")), debug=os.getenv("FLASK_DEBUG") == "1")
