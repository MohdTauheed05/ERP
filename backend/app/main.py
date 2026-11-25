from datetime import datetime, timezone
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session
from backend.app.core.config import settings
from backend.app.core.security import create_access_token, get_current_user, hash_password, require_permission, verify_password
from backend.app.database.session import Base, engine, get_db
from backend.app.models.erp_models import Item, Role, Supplier, Customer, User, Warehouse

Base.metadata.create_all(bind=engine)

app = FastAPI(title=settings.APP_NAME, version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SetupAdminPayload(BaseModel):
    username: str
    email: str
    full_name: str
    password: str


class LoginPayload(BaseModel):
    identifier: str
    password: str


@app.get("/api/health")
def health(db: Session = Depends(get_db)):
    db.execute(text("SELECT 1"))
    return {"status": "ok", "engine": "postgresql" if settings.DATABASE_URL.startswith("postgresql") else "sqlite"}


@app.get("/api/auth/status")
def auth_status(db: Session = Depends(get_db)):
    count = db.query(User).count()
    return {"needsSetup": count == 0}


@app.post("/api/auth/setup-admin", status_code=201)
def setup_admin(body: SetupAdminPayload, db: Session = Depends(get_db)):
    if db.query(User).count() > 0:
        raise HTTPException(status_code=403, detail="Super Admin already configured")
    now = datetime.now(timezone.utc).isoformat()
    role = db.query(Role).filter(Role.name == "Super Admin").first()
    if not role:
        role = Role(name="Super Admin", description="Full ERP Administrator", is_system=1, is_active=1, created_at=now)
        db.add(role)
        db.flush()

    user = User(
        username=body.username.strip(),
        email=body.email.strip().lower(),
        full_name=body.full_name.strip(),
        password_hash=hash_password(body.password),
        role_id=role.id,
        department="Executive",
        is_active=1,
        created_at=now,
        updated_at=now,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_access_token({"sub": str(user.id), "role_id": user.role_id})
    return {"token": token, "user": {"id": user.id, "username": user.username, "full_name": user.full_name}}


@app.post("/api/auth/login")
def login(body: LoginPayload, db: Session = Depends(get_db)):
    ident = body.identifier.strip().lower()
    user = db.query(User).filter((User.email == ident) | (User.username == body.identifier.strip())).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_access_token({"sub": str(user.id), "role_id": user.role_id})
    return {"token": token, "user": {"id": user.id, "username": user.username, "full_name": user.full_name}}


@app.get("/api/masters/items")
def list_items(_u: User = Depends(require_permission("masters", "can_view")), db: Session = Depends(get_db)):
    return {"items": db.query(Item).all()}


@app.get("/api/masters/suppliers")
def list_suppliers(_u: User = Depends(require_permission("masters", "can_view")), db: Session = Depends(get_db)):
    return {"items": db.query(Supplier).all()}


@app.get("/api/masters/customers")
def list_customers(_u: User = Depends(require_permission("masters", "can_view")), db: Session = Depends(get_db)):
    return {"items": db.query(Customer).all()}


@app.get("/api/masters/warehouses")
def list_warehouses(_u: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"items": db.query(Warehouse).all()}
