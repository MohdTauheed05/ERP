from sqlalchemy import Column, Float, ForeignKey, Integer, Numeric, String, Text
from backend.app.database.session import Base


class Company(Base):
    __tablename__ = "companies"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    logo_path = Column(Text, default="")
    address = Column(Text, default="")
    country = Column(String(100), default="United Arab Emirates")
    trn = Column(String(64), default="")
    telephone = Column(String(50), default="")
    email = Column(String(120), default="")
    website = Column(String(120), default="")
    currency = Column(String(10), default="AED")
    financial_year_start = Column(String(20), default="2026-01-01")
    financial_year_end = Column(String(20), default="2026-12-31")
    vat_rate = Column(Numeric(6, 2), default=5.0)
    vat_enabled = Column(Integer, default=1)
    updated_at = Column(String(40), nullable=False)


class Role(Base):
    __tablename__ = "roles"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), unique=True, nullable=False)
    description = Column(Text, default="")
    is_system = Column(Integer, default=0)
    is_active = Column(Integer, default=1)
    created_at = Column(String(40), nullable=False)


class RolePermission(Base):
    __tablename__ = "role_permissions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    role_id = Column(Integer, ForeignKey("roles.id", ondelete="CASCADE"), nullable=False)
    module = Column(String(60), nullable=False)
    doc_type = Column(String(60), nullable=False)
    can_view = Column(Integer, default=0)
    can_create = Column(Integer, default=0)
    can_edit = Column(Integer, default=0)
    can_delete = Column(Integer, default=0)
    can_submit = Column(Integer, default=0)
    can_cancel = Column(Integer, default=0)
    can_amend = Column(Integer, default=0)
    can_approve = Column(Integer, default=0)
    can_export = Column(Integer, default=0)
    can_print = Column(Integer, default=0)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(80), unique=True, nullable=False)
    email = Column(String(120), unique=True, nullable=False)
    full_name = Column(String(150), nullable=False)
    password_hash = Column(Text, nullable=False)
    role_id = Column(Integer, ForeignKey("roles.id"), nullable=False)
    department = Column(String(80), default="Operations")
    is_active = Column(Integer, default=1)
    last_login_at = Column(String(40))
    created_at = Column(String(40), nullable=False)
    updated_at = Column(String(40), nullable=False)


class ItemCategory(Base):
    __tablename__ = "item_categories"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(120), unique=True, nullable=False)
    description = Column(Text, default="")
    is_raw_material = Column(Integer, default=0)
    is_finished_good = Column(Integer, default=0)
    is_packaging = Column(Integer, default=0)


class Warehouse(Base):
    __tablename__ = "warehouses"
    id = Column(Integer, primary_key=True, autoincrement=True)
    code = Column(String(30), unique=True, nullable=False)
    name = Column(String(150), unique=True, nullable=False)
    location = Column(String(150), default="")
    warehouse_type = Column(String(50), default="Standard")
    is_subcontractor = Column(Integer, default=0)
    is_active = Column(Integer, default=1)


class Supplier(Base):
    __tablename__ = "suppliers"
    id = Column(Integer, primary_key=True, autoincrement=True)
    code = Column(String(40), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    contact_person = Column(String(120), default="")
    email = Column(String(120), default="")
    telephone = Column(String(60), default="")
    country = Column(String(80), default="United Arab Emirates")
    payment_term_id = Column(Integer)
    credit_limit = Column(Numeric(14, 2), default=0)
    trn = Column(String(64), default="")
    currency = Column(String(10), default="AED")
    is_active = Column(Integer, default=1)
    created_at = Column(String(40), nullable=False)
    updated_at = Column(String(40), nullable=False)


class Customer(Base):
    __tablename__ = "customers"
    id = Column(Integer, primary_key=True, autoincrement=True)
    code = Column(String(40), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    contact_person = Column(String(120), default="")
    telephone = Column(String(60), default="")
    email = Column(String(120), default="")
    country = Column(String(80), default="United Arab Emirates")
    payment_term_id = Column(Integer)
    credit_limit = Column(Numeric(14, 2), default=0)
    trn = Column(String(64), default="")
    currency = Column(String(10), default="AED")
    is_active = Column(Integer, default=1)
    created_at = Column(String(40), nullable=False)
    updated_at = Column(String(40), nullable=False)


class Item(Base):
    __tablename__ = "items"
    id = Column(Integer, primary_key=True, autoincrement=True)
    item_code = Column(String(60), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    category_id = Column(Integer, ForeignKey("item_categories.id"), nullable=False)
    brand = Column(String(100), default="")
    purchase_uom = Column(String(20), default="LTR")
    stock_uom = Column(String(20), default="LTR")
    sales_uom = Column(String(20), default="LTR")
    reorder_level = Column(Float, default=0)
    standard_cost = Column(Numeric(14, 4), default=0)
    average_cost = Column(Numeric(14, 4), default=0)
    selling_price = Column(Numeric(14, 4), default=0)
    vat_rate = Column(Numeric(6, 2), default=5.0)
    batch_tracking = Column(Integer, default=1)
    default_warehouse_id = Column(Integer, ForeignKey("warehouses.id"))
    valuation_method = Column(String(30), default="Moving Average")
    is_active = Column(Integer, default=1)
    created_at = Column(String(40), nullable=False)
    updated_at = Column(String(40), nullable=False)


class StockLedger(Base):
    __tablename__ = "stock_ledger"
    id = Column(Integer, primary_key=True, autoincrement=True)
    posting_date = Column(String(20), nullable=False)
    doc_type = Column(String(50), nullable=False)
    doc_id = Column(Integer, nullable=False)
    doc_number = Column(String(60), nullable=False)
    item_id = Column(Integer, ForeignKey("items.id"), nullable=False)
    warehouse_id = Column(Integer, ForeignKey("warehouses.id"), nullable=False)
    batch_id = Column(Integer)
    inward_qty = Column(Float, default=0)
    outward_qty = Column(Float, default=0)
    closing_qty = Column(Float, nullable=False)
    unit_cost = Column(Numeric(14, 4), nullable=False)
    stock_value = Column(Numeric(16, 2), nullable=False)
    created_at = Column(String(40), nullable=False)


class JournalEntry(Base):
    __tablename__ = "journal_entries"
    id = Column(Integer, primary_key=True, autoincrement=True)
    je_number = Column(String(60), unique=True, nullable=False)
    posting_date = Column(String(20), nullable=False)
    entry_type = Column(String(60), nullable=False)
    ref_doc_type = Column(String(60), default="")
    ref_doc_id = Column(Integer)
    ref_doc_number = Column(String(60), default="")
    narration = Column(Text, default="")
    total_debit = Column(Numeric(16, 2), nullable=False)
    total_credit = Column(Numeric(16, 2), nullable=False)
    status = Column(String(30), default="Posted")
    created_at = Column(String(40), nullable=False)


class JournalEntryLine(Base):
    __tablename__ = "journal_entry_lines"
    id = Column(Integer, primary_key=True, autoincrement=True)
    je_id = Column(Integer, ForeignKey("journal_entries.id", ondelete="CASCADE"), nullable=False)
    account_id = Column(Integer, nullable=False)
    party_type = Column(String(30), default="")
    party_id = Column(Integer)
    debit = Column(Numeric(16, 2), default=0)
    credit = Column(Numeric(16, 2), default=0)
    currency = Column(String(10), default="AED")
    exchange_rate = Column(Numeric(14, 6), default=1)
    debit_base = Column(Numeric(16, 2), default=0)
    credit_base = Column(Numeric(16, 2), default=0)
    description = Column(Text, default="")
