import React, { useEffect, useMemo, useState } from 'react';
import { Building2, ChevronDown, ChevronRight, Database, Edit2, FileSpreadsheet, FolderPlus, FolderTree, ImageUp, Plus, Trash2 } from 'lucide-react';
import { apiRequest } from '../../services/api';
import { DataTable, type ColumnDef } from '../../components/DataTable';
import { ExcelImportModal, type ImportType } from '../../components/ExcelImportModal';
import { useCompany } from '../../context/CompanyContext';

type MasterTab = 'items' | 'suppliers' | 'customers' | 'warehouses' | 'pricelists' | 'currencies' | 'paymentTerms' | 'company';

interface ItemGroup {
  id: number;
  group_code: string;
  name: string;
  parent_id: number | null;
  is_group: number;
  description: string;
  is_raw_material: number;
  is_finished_good: number;
  is_packaging: number;
  sort_order: number;
  parent_name?: string;
  item_count?: number;
}

export function MastersView() {
  const { logoUrl, refreshCompany } = useCompany();
  const [tab, setTab] = useState<MasterTab>('items');
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [suppliers, setSuppliers] = useState<Record<string, unknown>[]>([]);
  const [customers, setCustomers] = useState<Record<string, unknown>[]>([]);
  const [categories, setCategories] = useState<ItemGroup[]>([]);
  const [uoms, setUoms] = useState<{ code: string; name: string }[]>([]);
  const [warehouses, setWarehouses] = useState<Record<string, unknown>[]>([]);
  const [tanks, setTanks] = useState<Record<string, unknown>[]>([]);
  const [priceLists, setPriceLists] = useState<Record<string, unknown>[]>([]);
  const [currencies, setCurrencies] = useState<Record<string, unknown>[]>([]);
  const [exchangeRates, setExchangeRates] = useState<Record<string, unknown>[]>([]);
  const [paymentTerms, setPaymentTerms] = useState<Record<string, unknown>[]>([]);
  const [company, setCompany] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

  // Hierarchical Group Tree state
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<number, boolean>>({});
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  const [groupForm, setGroupForm] = useState({
    group_code: '',
    name: '',
    parent_id: '' as string,
    is_group: true,
    description: '',
    is_raw_material: true,
    is_finished_good: false,
    is_packaging: false,
    sort_order: '0',
  });

  // Item modal state (Create & Edit)
  const [showItemForm, setShowItemForm] = useState(false);
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [itemForm, setItemForm] = useState({
    item_code: '',
    name: '',
    description: '',
    category_id: '',
    brand: '',
    sku: '',
    barcode: '',
    purchase_uom: 'LTR',
    stock_uom: 'LTR',
    sales_uom: 'LTR',
    reorder_level: '500',
    min_stock: '0',
    max_stock: '0',
    safety_stock: '0',
    moq: '1',
    lead_time_days: '7',
    standard_cost: '0',
    selling_price: '0',
    vat_rate: '5',
    default_warehouse_id: '',
    batch_tracking: true,
  });

  // Supplier & Customer modals (Create & Edit)
  const [showSupForm, setShowSupForm] = useState(false);
  const [editingSupId, setEditingSupId] = useState<number | null>(null);
  const [supForm, setSupForm] = useState({
    name: '',
    contact_person: '',
    email: '',
    telephone: '',
    address: '',
    country: 'United Arab Emirates',
    trn: '',
    currency: 'AED',
    credit_limit: '100000',
  });

  const [showCustForm, setShowCustForm] = useState(false);
  const [editingCustId, setEditingCustId] = useState<number | null>(null);
  const [custForm, setCustForm] = useState({
    name: '',
    contact_person: '',
    email: '',
    telephone: '',
    address: '',
    country: 'United Arab Emirates',
    trn: '',
    currency: 'AED',
    credit_limit: '100000',
  });

  // Warehouse & Tank modals
  const [showWhForm, setShowWhForm] = useState(false);
  const [editingWhId, setEditingWhId] = useState<number | null>(null);
  const [whForm, setWhForm] = useState({ code: '', name: '', warehouse_type: 'Raw Material', location: '', is_subcontractor: false });

  const [showTankForm, setShowTankForm] = useState(false);
  const [editingTankId, setEditingTankId] = useState<number | null>(null);
  const [tankForm, setTankForm] = useState({
    tank_code: '',
    name: '',
    warehouse_id: '',
    tank_type: 'Base Oil',
    capacity_qty: '25000',
    uom: 'LTR',
    assigned_item_id: '',
    min_heel_qty: '500',
    temperature_c: '28',
    notes: '',
  });

  const [assignTank, setAssignTank] = useState<Record<string, unknown> | null>(null);
  const [assignItemId, setAssignItemId] = useState<string>('');

  const [fxForm, setFxForm] = useState({ from_currency: 'USD', to_currency: 'AED', rate: '3.6725' });
  const [ptForm, setPtForm] = useState({ name: '', description: '', inst1Pct: '50', inst1Days: '50', inst2Pct: '50', inst2Days: '80' });

  const loadAll = async () => {
    setLoading(true);
    try {
      const [it, sup, cust, cat, uom, wh, tk, pl, cur, pt, comp] = await Promise.all([
        apiRequest<{ items: Record<string, unknown>[] }>('/api/masters/items'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/masters/suppliers'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/masters/customers'),
        apiRequest<{ items: ItemGroup[] }>('/api/masters/categories'),
        apiRequest<{ uoms: { code: string; name: string }[] }>('/api/masters/uoms'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/masters/warehouses'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/masters/tanks'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/masters/price-lists'),
        apiRequest<{ currencies: Record<string, unknown>[]; exchangeRates: Record<string, unknown>[] }>('/api/masters/currencies'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/masters/payment-terms'),
        apiRequest<{ company: Record<string, unknown> }>('/api/masters/company'),
      ]);
      setItems(it.items);
      setSuppliers(sup.items);
      setCustomers(cust.items);
      setCategories(cat.items);
      setUoms(uom.uoms);
      setWarehouses(wh.items);
      setTanks(tk.items);
      setPriceLists(pl.items);
      setCurrencies(cur.currencies);
      setExchangeRates(cur.exchangeRates);
      setPaymentTerms(pt.items);
      setCompany(comp.company || {});

      setExpandedGroups((prev) => {
        if (Object.keys(prev).length > 0) return prev;
        const next: Record<number, boolean> = {};
        cat.items.filter((c) => !c.parent_id).forEach((c) => {
          next[c.id] = true;
        });
        return next;
      });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to load master data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  // Build hierarchical tree helpers
  const childrenMap = useMemo(() => {
    const map = new Map<number | null, ItemGroup[]>();
    for (const c of categories) {
      const pid = c.parent_id ?? null;
      const list = map.get(pid) || [];
      list.push(c);
      map.set(pid, list);
    }
    return map;
  }, [categories]);

  const selectedDescendantIds = useMemo(() => {
    if (selectedGroupId === null) return null;
    const set = new Set<number>([selectedGroupId]);
    const stack = [selectedGroupId];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const ch of childrenMap.get(cur) || []) {
        if (!set.has(ch.id)) {
          set.add(ch.id);
          stack.push(ch.id);
        }
      }
    }
    return set;
  }, [selectedGroupId, childrenMap]);

  const filteredItems = useMemo(() => {
    if (!selectedDescendantIds) return items;
    return items.filter((it) => selectedDescendantIds.has(Number(it.category_id)));
  }, [items, selectedDescendantIds]);

  const getDescendantItemCount = (groupId: number): number => {
    const own = categories.find((c) => c.id === groupId)?.item_count || 0;
    const kids = childrenMap.get(groupId) || [];
    return own + kids.reduce((sum, k) => sum + getDescendantItemCount(k.id), 0);
  };

  const openNewGroupModal = (defaultParentId?: number | null) => {
    setEditingGroupId(null);
    setGroupForm({
      group_code: '',
      name: '',
      parent_id: defaultParentId ? String(defaultParentId) : '',
      is_group: true,
      description: '',
      is_raw_material: true,
      is_finished_good: false,
      is_packaging: false,
      sort_order: '0',
    });
    setShowGroupModal(true);
  };

  const openEditGroupModal = (g: ItemGroup) => {
    setEditingGroupId(g.id);
    setGroupForm({
      group_code: g.group_code || '',
      name: g.name || '',
      parent_id: g.parent_id ? String(g.parent_id) : '',
      is_group: Boolean(g.is_group),
      description: g.description || '',
      is_raw_material: Boolean(g.is_raw_material),
      is_finished_good: Boolean(g.is_finished_good),
      is_packaging: Boolean(g.is_packaging),
      sort_order: String(g.sort_order ?? 0),
    });
    setShowGroupModal(true);
  };

  const saveGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const payload = {
        group_code: groupForm.group_code || groupForm.name.toUpperCase(),
        name: groupForm.name,
        parent_id: groupForm.parent_id ? Number(groupForm.parent_id) : null,
        is_group: groupForm.is_group ? 1 : 0,
        description: groupForm.description,
        is_raw_material: groupForm.is_raw_material ? 1 : 0,
        is_finished_good: groupForm.is_finished_good ? 1 : 0,
        is_packaging: groupForm.is_packaging ? 1 : 0,
        sort_order: Number(groupForm.sort_order || 0),
      };
      if (editingGroupId) {
        await apiRequest(`/api/masters/categories/${editingGroupId}`, { method: 'PUT', body: JSON.stringify(payload) });
        setMsg(`Item Group "${groupForm.name}" updated.`);
      } else {
        const res = await apiRequest<{ id: number }>('/api/masters/categories', { method: 'POST', body: JSON.stringify(payload) });
        setSelectedGroupId(res.id);
        if (payload.parent_id) setExpandedGroups((prev) => ({ ...prev, [payload.parent_id!]: true }));
        setMsg(`Item Group "${groupForm.name}" created.`);
      }
      setShowGroupModal(false);
      await loadAll();
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Failed to save item group');
    }
  };

  const openNewItemModal = () => {
    setEditingItemId(null);
    setItemForm({
      item_code: '',
      name: '',
      description: '',
      category_id: String(selectedGroupId || categories[0]?.id || ''),
      brand: '',
      sku: '',
      barcode: '',
      purchase_uom: 'PCS',
      stock_uom: 'PCS',
      sales_uom: 'PCS',
      reorder_level: '500',
      min_stock: '0',
      max_stock: '0',
      safety_stock: '0',
      moq: '1',
      lead_time_days: '7',
      standard_cost: '0',
      selling_price: '0',
      vat_rate: '5',
      default_warehouse_id: String(warehouses[0]?.id || ''),
      batch_tracking: true,
    });
    setShowItemForm(true);
  };

  const openEditItemModal = (r: Record<string, unknown>) => {
    setEditingItemId(Number(r.id));
    setItemForm({
      item_code: String(r.item_code || ''),
      name: String(r.name || ''),
      description: String(r.description || ''),
      category_id: String(r.category_id || ''),
      brand: String(r.brand || ''),
      sku: String(r.sku || ''),
      barcode: String(r.barcode || ''),
      purchase_uom: String(r.purchase_uom || 'LTR'),
      stock_uom: String(r.stock_uom || 'LTR'),
      sales_uom: String(r.sales_uom || 'LTR'),
      reorder_level: String(r.reorder_level ?? 0),
      min_stock: String(r.min_stock ?? 0),
      max_stock: String(r.max_stock ?? 0),
      safety_stock: String(r.safety_stock ?? 0),
      moq: String(r.moq ?? 1),
      lead_time_days: String(r.lead_time_days ?? 7),
      standard_cost: String(r.standard_cost ?? 0),
      selling_price: String(r.selling_price ?? 0),
      vat_rate: String(r.vat_rate ?? 5),
      default_warehouse_id: r.default_warehouse_id ? String(r.default_warehouse_id) : '',
      batch_tracking: Boolean(r.batch_tracking),
    });
    setShowItemForm(true);
  };

  const saveItem = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const payload = {
        ...itemForm,
        category_id: Number(itemForm.category_id || categories[0]?.id),
        reorder_level: Number(itemForm.reorder_level || 0),
        min_stock: Number(itemForm.min_stock || 0),
        max_stock: Number(itemForm.max_stock || 0),
        safety_stock: Number(itemForm.safety_stock || 0),
        moq: Number(itemForm.moq || 1),
        lead_time_days: Number(itemForm.lead_time_days || 7),
        standard_cost: Number(itemForm.standard_cost || 0),
        selling_price: Number(itemForm.selling_price || 0),
        vat_rate: Number(itemForm.vat_rate ?? 5),
        default_warehouse_id: itemForm.default_warehouse_id ? Number(itemForm.default_warehouse_id) : null,
        batch_tracking: itemForm.batch_tracking ? 1 : 0,
      };
      if (editingItemId) {
        await apiRequest(`/api/masters/items/${editingItemId}`, { method: 'PUT', body: JSON.stringify(payload) });
        setMsg(`Item ${itemForm.item_code} updated.`);
      } else {
        await apiRequest('/api/masters/items', { method: 'POST', body: JSON.stringify(payload) });
        setMsg(`Item ${itemForm.item_code} created in group.`);
      }
      setShowItemForm(false);
      await loadAll();
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Failed to save item');
    }
  };

  const saveSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const payload = { ...supForm, credit_limit: Number(supForm.credit_limit || 0) };
      if (editingSupId) {
        await apiRequest(`/api/masters/suppliers/${editingSupId}`, { method: 'PUT', body: JSON.stringify(payload) });
        setMsg('Supplier updated.');
      } else {
        await apiRequest('/api/masters/suppliers', { method: 'POST', body: JSON.stringify(payload) });
        setMsg('Supplier created.');
      }
      setShowSupForm(false);
      await loadAll();
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Failed to save supplier');
    }
  };

  const saveCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const payload = { ...custForm, credit_limit: Number(custForm.credit_limit || 0) };
      if (editingCustId) {
        await apiRequest(`/api/masters/customers/${editingCustId}`, { method: 'PUT', body: JSON.stringify(payload) });
        setMsg('Customer updated.');
      } else {
        await apiRequest('/api/masters/customers', { method: 'POST', body: JSON.stringify(payload) });
        setMsg('Customer created.');
      }
      setShowCustForm(false);
      await loadAll();
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Failed to save customer');
    }
  };

  const saveWarehouse = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const payload = { ...whForm, is_subcontractor: whForm.is_subcontractor ? 1 : 0 };
      if (editingWhId) {
        await apiRequest(`/api/masters/warehouses/${editingWhId}`, { method: 'PUT', body: JSON.stringify(payload) });
        setMsg('Warehouse updated.');
      } else {
        await apiRequest('/api/masters/warehouses', { method: 'POST', body: JSON.stringify(payload) });
        setMsg('Warehouse created.');
      }
      setShowWhForm(false);
      await loadAll();
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Failed to save warehouse');
    }
  };

  const saveTank = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const payload = {
        ...tankForm,
        warehouse_id: Number(tankForm.warehouse_id),
        capacity_qty: Number(tankForm.capacity_qty),
        assigned_item_id: tankForm.assigned_item_id ? Number(tankForm.assigned_item_id) : null,
        min_heel_qty: Number(tankForm.min_heel_qty || 0),
        temperature_c: Number(tankForm.temperature_c || 25),
      };
      if (editingTankId) {
        await apiRequest(`/api/masters/tanks/${editingTankId}`, { method: 'PUT', body: JSON.stringify(payload) });
        setMsg(`Storage Tank ${tankForm.tank_code} updated.`);
      } else {
        await apiRequest('/api/masters/tanks', { method: 'POST', body: JSON.stringify(payload) });
        setMsg(`Storage Tank ${tankForm.tank_code} created.`);
      }
      setShowTankForm(false);
      await loadAll();
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Failed to save storage tank');
    }
  };

  const saveCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      await apiRequest('/api/masters/company', { method: 'PUT', body: JSON.stringify(company) });
      await refreshCompany();
      await loadAll();
      setMsg('Company master updated across UI and all PDFs.');
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Failed to update company');
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingLogo(true);
    setErr('');
    try {
      const fd = new FormData();
      fd.append('logo', file);
      await apiRequest('/api/masters/company/logo', { method: 'POST', body: fd });
      await refreshCompany();
      await loadAll();
      setMsg('Company logo updated across ERP UI & PDFs.');
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Failed to upload logo');
    } finally {
      setUploadingLogo(false);
      e.target.value = '';
    }
  };

  const renderGroupNode = (g: ItemGroup, depth = 0): React.ReactNode => {
    const kids = childrenMap.get(g.id) || [];
    const isExpanded = Boolean(expandedGroups[g.id]);
    const isSelected = selectedGroupId === g.id;
    const totalItems = getDescendantItemCount(g.id);

    return (
      <div key={g.id}>
        <div
          className={`flex items-center justify-between gap-1 px-2 py-1.5 rounded text-xs cursor-pointer ${
            isSelected ? 'bg-slate-900 text-white' : 'hover:bg-slate-100 text-slate-800'
          }`}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onClick={() => setSelectedGroupId(g.id)}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            {kids.length > 0 ? (
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setExpandedGroups((prev) => ({ ...prev, [g.id]: !prev[g.id] }));
                }}
                className="p-0.5 hover:opacity-80"
              >
                {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
            ) : (
              <span className="w-4 inline-block" />
            )}
            <span className="truncate font-medium">{g.name}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${isSelected ? 'bg-slate-700 text-slate-100' : 'bg-slate-200 text-slate-700'}`}>
              {totalItems}
            </span>
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                openNewGroupModal(g.id);
              }}
              title="Add Sub-Group"
              className={`p-0.5 rounded ${isSelected ? 'hover:bg-slate-700' : 'hover:bg-slate-200 text-slate-500'}`}
            >
              <Plus className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                openEditGroupModal(g);
              }}
              title="Edit Group"
              className={`p-0.5 rounded ${isSelected ? 'hover:bg-slate-700' : 'hover:bg-slate-200 text-slate-500'}`}
            >
              <Edit2 className="w-3 h-3" />
            </button>
          </div>
        </div>
        {kids.length > 0 && isExpanded && kids.map((k) => renderGroupNode(k, depth + 1))}
      </div>
    );
  };

  const itemCols: ColumnDef<Record<string, unknown>>[] = [
    { key: 'item_code', header: 'Item Code', render: (r) => <span className="font-mono font-medium">{String(r.item_code)}</span> },
    { key: 'name', header: 'Product Name' },
    {
      key: 'category_name',
      header: 'Item Group',
      render: (r) => (
        <span className="text-xs">
          {r.parent_category_name ? <span className="text-slate-400">{String(r.parent_category_name)} / </span> : null}
          <span className="font-medium text-slate-800">{String(r.category_name)}</span>
        </span>
      ),
    },
    { key: 'stock_uom', header: 'UOM' },
    { key: 'current_stock', header: 'On Hand', numeric: true },
    { key: 'reorder_level', header: 'Reorder Lvl', numeric: true },
    { key: 'average_cost', header: 'Avg Cost', numeric: true, render: (r) => Number(r.average_cost || 0).toFixed(2) },
    { key: 'selling_price', header: 'Sell Price', numeric: true, render: (r) => Number(r.selling_price || 0).toFixed(2) },
    {
      key: 'actions',
      header: 'Edit',
      render: (r) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openEditItemModal(r);
          }}
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border border-slate-300 rounded hover:bg-slate-50"
        >
          <Edit2 className="w-3 h-3" /> Edit
        </button>
      ),
    },
  ];

  const supCols: ColumnDef<Record<string, unknown>>[] = [
    { key: 'code', header: 'Code' },
    { key: 'name', header: 'Supplier Name' },
    { key: 'trn', header: 'TRN' },
    { key: 'country', header: 'Country' },
    { key: 'currency', header: 'Curr' },
    { key: 'current_outstanding', header: 'Payable Balance', numeric: true, render: (r) => Number(r.current_outstanding || 0).toFixed(2) },
    {
      key: 'actions',
      header: 'Edit',
      render: (r) => (
        <button
          type="button"
          onClick={() => {
            setEditingSupId(Number(r.id));
            setSupForm({
              name: String(r.name || ''),
              contact_person: String(r.contact_person || ''),
              email: String(r.email || ''),
              telephone: String(r.telephone || ''),
              address: String(r.address || ''),
              country: String(r.country || 'United Arab Emirates'),
              trn: String(r.trn || ''),
              currency: String(r.currency || 'AED'),
              credit_limit: String(r.credit_limit ?? 0),
            });
            setShowSupForm(true);
          }}
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border border-slate-300 rounded hover:bg-slate-50"
        >
          <Edit2 className="w-3 h-3" /> Edit
        </button>
      ),
    },
  ];

  const custCols: ColumnDef<Record<string, unknown>>[] = [
    { key: 'code', header: 'Code' },
    { key: 'name', header: 'Customer Name' },
    { key: 'trn', header: 'TRN' },
    { key: 'country', header: 'Country' },
    { key: 'currency', header: 'Curr' },
    { key: 'current_outstanding', header: 'Receivable Balance', numeric: true, render: (r) => Number(r.current_outstanding || 0).toFixed(2) },
    {
      key: 'actions',
      header: 'Edit',
      render: (r) => (
        <button
          type="button"
          onClick={() => {
            setEditingCustId(Number(r.id));
            setCustForm({
              name: String(r.name || ''),
              contact_person: String(r.contact_person || ''),
              email: String(r.email || ''),
              telephone: String(r.telephone || ''),
              address: String(r.address || ''),
              country: String(r.country || 'United Arab Emirates'),
              trn: String(r.trn || ''),
              currency: String(r.currency || 'AED'),
              credit_limit: String(r.credit_limit ?? 0),
            });
            setShowCustForm(true);
          }}
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border border-slate-300 rounded hover:bg-slate-50"
        >
          <Edit2 className="w-3 h-3" /> Edit
        </button>
      ),
    },
  ];

  const tabs: { id: MasterTab; label: string }[] = [
    { id: 'items', label: 'Items & Groups' },
    { id: 'suppliers', label: 'Suppliers' },
    { id: 'customers', label: 'Customers' },
    { id: 'warehouses', label: 'Warehouses, Tanks & UOM' },
    { id: 'pricelists', label: 'Price Lists' },
    { id: 'currencies', label: 'Currencies & FX' },
    { id: 'paymentTerms', label: 'Payment Terms' },
    { id: 'company', label: 'Company Profile' },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Master Data Management</h1>
          <p className="text-xs text-slate-500">Group-wise item hierarchy, suppliers, customers, multi-tank warehouses & company branding</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowImportModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" /> Import Excel & Templates
          </button>
          {tab === 'items' && (
            <>
              <button type="button" onClick={() => openNewGroupModal(selectedGroupId)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50">
                <FolderPlus className="w-3.5 h-3.5" /> New Group
              </button>
              <button type="button" onClick={openNewItemModal} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800">
                <Plus className="w-3.5 h-3.5" /> New Item
              </button>
            </>
          )}
          {tab === 'suppliers' && (
            <button
              type="button"
              onClick={() => {
                setEditingSupId(null);
                setSupForm({ name: '', contact_person: '', email: '', telephone: '', address: '', country: 'United Arab Emirates', trn: '', currency: 'AED', credit_limit: '100000' });
                setShowSupForm(true);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800"
            >
              <Plus className="w-3.5 h-3.5" /> New Supplier
            </button>
          )}
          {tab === 'customers' && (
            <button
              type="button"
              onClick={() => {
                setEditingCustId(null);
                setCustForm({ name: '', contact_person: '', email: '', telephone: '', address: '', country: 'United Arab Emirates', trn: '', currency: 'AED', credit_limit: '100000' });
                setShowCustForm(true);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800"
            >
              <Plus className="w-3.5 h-3.5" /> New Customer
            </button>
          )}
          {tab === 'warehouses' && (
            <>
              <button
                type="button"
                onClick={() => {
                  setEditingWhId(null);
                  setWhForm({ code: '', name: '', warehouse_type: 'Raw Material', location: '', is_subcontractor: false });
                  setShowWhForm(true);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
              >
                <Plus className="w-3.5 h-3.5" /> New Warehouse
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingTankId(null);
                  setTankForm({
                    tank_code: '',
                    name: '',
                    warehouse_id: String(warehouses[0]?.id || ''),
                    tank_type: 'Base Oil',
                    capacity_qty: '25000',
                    uom: 'LTR',
                    assigned_item_id: '',
                    min_heel_qty: '500',
                    temperature_c: '28',
                    notes: '',
                  });
                  setShowTankForm(true);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800"
              >
                <Database className="w-3.5 h-3.5" /> New Storage Tank
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {msg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-800">{msg}</div>}
      {err && <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{err}</div>}

      {tab === 'items' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <div className="lg:col-span-3 bg-white border border-slate-200 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
                <FolderTree className="w-4 h-4 text-slate-600" />
                <span>Item Groups Tree</span>
              </div>
              <button
                type="button"
                onClick={() => openNewGroupModal(null)}
                className="text-[11px] font-medium text-slate-700 hover:text-slate-900 underline"
              >
                + Root
              </button>
            </div>
            <div
              onClick={() => setSelectedGroupId(null)}
              className={`flex items-center justify-between px-2 py-1.5 rounded text-xs cursor-pointer ${
                selectedGroupId === null ? 'bg-slate-900 text-white' : 'hover:bg-slate-100 text-slate-800'
              }`}
            >
              <span className="font-medium">All Item Groups</span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${selectedGroupId === null ? 'bg-slate-700 text-slate-100' : 'bg-slate-200 text-slate-700'}`}>
                {items.length}
              </span>
            </div>
            <div className="space-y-0.5 max-h-[540px] overflow-y-auto pr-1">
              {(childrenMap.get(null) || []).map((g) => renderGroupNode(g, 0))}
            </div>
          </div>

          <div className="lg:col-span-9">
            <DataTable
              title={
                selectedGroupId
                  ? `Items in Group: ${categories.find((c) => c.id === selectedGroupId)?.name || ''}`
                  : 'All Items & Products'
              }
              columns={itemCols}
              data={filteredItems}
              loading={loading}
              exportFilename="items_master"
              emptyActionLabel="Create Item in Group"
              onEmptyAction={openNewItemModal}
            />
          </div>
        </div>
      )}

      {tab === 'suppliers' && (
        <DataTable title="Suppliers" columns={supCols} data={suppliers} loading={loading} exportFilename="suppliers_master" />
      )}

      {tab === 'customers' && (
        <DataTable title="Customers" columns={custCols} data={customers} loading={loading} exportFilename="customers_master" />
      )}

      {tab === 'warehouses' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <DataTable
              title="Warehouses"
              columns={[
                { key: 'code', header: 'Code' },
                { key: 'name', header: 'Warehouse Name' },
                { key: 'warehouse_type', header: 'Type' },
                { key: 'location', header: 'Location' },
                {
                  key: 'actions',
                  header: 'Edit',
                  render: (r) => (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingWhId(Number(r.id));
                        setWhForm({
                          code: String(r.code || ''),
                          name: String(r.name || ''),
                          warehouse_type: String(r.warehouse_type || 'Standard'),
                          location: String(r.location || ''),
                          is_subcontractor: Boolean(r.is_subcontractor),
                        });
                        setShowWhForm(true);
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border border-slate-300 rounded hover:bg-slate-50"
                    >
                      <Edit2 className="w-3 h-3" /> Edit
                    </button>
                  ),
                },
              ]}
              data={warehouses}
              exportFilename="warehouses"
            />
            <DataTable
              title="Units of Measure (UOM)"
              columns={[
                { key: 'code', header: 'Code' },
                { key: 'name', header: 'Unit Name' },
              ]}
              data={uoms}
              exportFilename="uoms"
            />
          </div>

          <DataTable
            title="Storage Tanks (Base Oils, Additives & Bulk Blends)"
            columns={[
              { key: 'tank_code', header: 'Tank Code', render: (r) => <span className="font-mono font-semibold">{String(r.tank_code)}</span> },
              { key: 'name', header: 'Tank Name' },
              { key: 'warehouse_name', header: 'Warehouse' },
              { key: 'tank_type', header: 'Type' },
              {
                key: 'assigned_item_name',
                header: 'Assigned Base Oil / Additive',
                render: (r) => (r.assigned_item_code ? `${String(r.assigned_item_code)} — ${String(r.assigned_item_name)}` : <span className="text-slate-400">Unassigned</span>),
              },
              { key: 'current_qty', header: 'Current Qty', numeric: true, render: (r) => `${Number(r.current_qty || 0).toLocaleString()} ${String(r.uom)}` },
              { key: 'capacity_qty', header: 'Capacity', numeric: true, render: (r) => `${Number(r.capacity_qty || 0).toLocaleString()} ${String(r.uom)}` },
              { key: 'fill_pct', header: 'Fill %', numeric: true, render: (r) => `${Number(r.fill_pct || 0).toFixed(1)}%` },
              {
                key: 'actions',
                header: 'Actions',
                render: (r) => (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setAssignTank(r);
                        setAssignItemId(r.assigned_item_id ? String(r.assigned_item_id) : '');
                      }}
                      className="px-2 py-1 text-[11px] bg-slate-900 text-white rounded hover:bg-slate-800"
                    >
                      Assign Material
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingTankId(Number(r.id));
                        setTankForm({
                          tank_code: String(r.tank_code || ''),
                          name: String(r.name || ''),
                          warehouse_id: String(r.warehouse_id || ''),
                          tank_type: String(r.tank_type || 'Base Oil'),
                          capacity_qty: String(r.capacity_qty ?? 25000),
                          uom: String(r.uom || 'LTR'),
                          assigned_item_id: r.assigned_item_id ? String(r.assigned_item_id) : '',
                          min_heel_qty: String(r.min_heel_qty ?? 0),
                          temperature_c: String(r.temperature_c ?? 25),
                          notes: String(r.notes || ''),
                        });
                        setShowTankForm(true);
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border border-slate-300 rounded hover:bg-slate-50"
                    >
                      <Edit2 className="w-3 h-3" /> Edit
                    </button>
                  </div>
                ),
              },
            ]}
            data={tanks}
            exportFilename="storage_tanks"
          />
        </div>
      )}

      {tab === 'pricelists' && (
        <DataTable
          title="Price Lists"
          columns={[
            { key: 'name', header: 'Price List' },
            { key: 'list_type', header: 'Type' },
            { key: 'currency', header: 'Currency' },
            { key: 'effective_from', header: 'Effective From' },
            { key: 'lines', header: 'Configured Items', numeric: true, render: (r) => Array.isArray(r.lines) ? r.lines.length : 0 },
          ]}
          data={priceLists}
          exportFilename="price_lists"
        />
      )}

      {tab === 'currencies' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <h3 className="text-sm font-semibold text-slate-900">Record Effective Exchange Rate</h3>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await apiRequest('/api/masters/exchange-rates', {
                  method: 'POST',
                  body: JSON.stringify({ ...fxForm, rate: Number(fxForm.rate) }),
                });
                setMsg('Exchange rate updated.');
                await loadAll();
              }}
              className="grid grid-cols-3 gap-3"
            >
              <select value={fxForm.from_currency} onChange={(e) => setFxForm({ ...fxForm, from_currency: e.target.value })} className="px-2 py-1.5 text-xs border border-slate-300 rounded">
                {currencies.map((c) => (
                  <option key={String(c.code)} value={String(c.code)}>{String(c.code)}</option>
                ))}
              </select>
              <input type="number" step="0.0001" value={fxForm.rate} onChange={(e) => setFxForm({ ...fxForm, rate: e.target.value })} className="px-2 py-1.5 text-xs border border-slate-300 rounded font-mono" />
              <button type="submit" className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded hover:bg-slate-800">Add Rate to AED</button>
            </form>
            <DataTable
              title="Exchange Rate History"
              columns={[
                { key: 'from_currency', header: 'From' },
                { key: 'to_currency', header: 'To' },
                { key: 'rate', header: 'Rate', numeric: true },
                { key: 'effective_date', header: 'Effective Date' },
              ]}
              data={exchangeRates}
              exportFilename="exchange_rates"
            />
          </div>
          <DataTable
            title="Active Currencies"
            columns={[
              { key: 'code', header: 'Code' },
              { key: 'name', header: 'Currency' },
              { key: 'symbol', header: 'Symbol' },
              { key: 'is_base', header: 'Base', render: (r) => (r.is_base ? 'Base Currency' : 'Foreign') },
            ]}
            data={currencies}
            exportFilename="currencies"
          />
        </div>
      )}

      {tab === 'paymentTerms' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-slate-900 mb-3">Create Multi-Installment Term</h3>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await apiRequest('/api/masters/payment-terms', {
                  method: 'POST',
                  body: JSON.stringify({
                    name: ptForm.name,
                    description: ptForm.description,
                    lines: [
                      { installment_no: 1, percentage: Number(ptForm.inst1Pct), days_due: Number(ptForm.inst1Days), payment_mode: 'PDC' },
                      ...(Number(ptForm.inst2Pct) > 0
                        ? [{ installment_no: 2, percentage: Number(ptForm.inst2Pct), days_due: Number(ptForm.inst2Days), payment_mode: 'PDC' }]
                        : []),
                    ],
                  }),
                });
                setMsg('Payment term created.');
                await loadAll();
              }}
              className="space-y-3 text-xs"
            >
              <input required placeholder="Term Name (e.g. 50% 50d / 50% 80d)" value={ptForm.name} onChange={(e) => setPtForm({ ...ptForm, name: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
              <input placeholder="Description" value={ptForm.description} onChange={(e) => setPtForm({ ...ptForm, description: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
              <div className="grid grid-cols-2 gap-2">
                <input type="number" placeholder="Inst 1 %" value={ptForm.inst1Pct} onChange={(e) => setPtForm({ ...ptForm, inst1Pct: e.target.value })} className="px-2 py-1.5 border border-slate-300 rounded" />
                <input type="number" placeholder="Inst 1 Days" value={ptForm.inst1Days} onChange={(e) => setPtForm({ ...ptForm, inst1Days: e.target.value })} className="px-2 py-1.5 border border-slate-300 rounded" />
                <input type="number" placeholder="Inst 2 %" value={ptForm.inst2Pct} onChange={(e) => setPtForm({ ...ptForm, inst2Pct: e.target.value })} className="px-2 py-1.5 border border-slate-300 rounded" />
                <input type="number" placeholder="Inst 2 Days" value={ptForm.inst2Days} onChange={(e) => setPtForm({ ...ptForm, inst2Days: e.target.value })} className="px-2 py-1.5 border border-slate-300 rounded" />
              </div>
              <button type="submit" className="w-full py-2 bg-slate-900 text-white rounded font-medium">Save Payment Term</button>
            </form>
          </div>
          <div className="lg:col-span-2">
            <DataTable
              title="Configured Payment Terms"
              columns={[
                { key: 'name', header: 'Term Name' },
                { key: 'description', header: 'Description' },
                {
                  key: 'lines',
                  header: 'Installments',
                  render: (r) =>
                    Array.isArray(r.lines)
                      ? (r.lines as { percentage: number; days_due: number; payment_mode: string }[])
                          .map((l) => `${l.percentage}% @ ${l.days_due}d (${l.payment_mode})`)
                          .join(' · ')
                      : '',
                },
              ]}
              data={paymentTerms}
              exportFilename="payment_terms"
            />
          </div>
        </div>
      )}

      {tab === 'company' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <form onSubmit={saveCompany} className="lg:col-span-2 bg-white border border-slate-200 rounded-lg p-6 space-y-4">
            <h3 className="text-sm font-semibold text-slate-900">Company Profile & Tax Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              {[
                ['name', 'Company Name'],
                ['short_name', 'Short Name'],
                ['trn', 'TRN / VAT Registration'],
                ['po_box', 'P.O. Box'],
                ['country', 'Country'],
                ['currency', 'Base Currency'],
                ['telephone', 'Telephone'],
                ['email', 'Email'],
                ['website', 'Website'],
                ['vat_rate', 'Default VAT Rate (%)'],
              ].map(([field, label]) => (
                <div key={field}>
                  <label className="block font-medium text-slate-700 mb-1">{label}</label>
                  <input
                    value={String(company[field] ?? '')}
                    onChange={(e) => setCompany({ ...company, [field]: e.target.value })}
                    className="w-full px-3 py-1.5 border border-slate-300 rounded"
                  />
                </div>
              ))}
              <div className="md:col-span-2">
                <label className="block font-medium text-slate-700 mb-1">Address</label>
                <input value={String(company.address ?? '')} onChange={(e) => setCompany({ ...company, address: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
              </div>
            </div>
            <button type="submit" className="px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded hover:bg-slate-800">Save Company Profile</button>
          </form>

          <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
            <h3 className="text-sm font-semibold text-slate-900">Company Logo</h3>
            <div className="border border-dashed border-slate-300 rounded-lg p-5 flex flex-col items-center justify-center bg-slate-50 min-h-[140px]">
              {logoUrl ? (
                <img src={logoUrl} alt="Company Logo" className="max-h-24 max-w-full object-contain" />
              ) : (
                <div className="text-center text-xs text-slate-400">
                  <Building2 className="w-8 h-8 mx-auto text-slate-300 mb-1" />
                  No logo uploaded
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded cursor-pointer">
                <ImageUp className="w-3.5 h-3.5" />
                {uploadingLogo ? 'Uploading...' : logoUrl ? 'Replace Logo' : 'Upload Logo'}
                <input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploadingLogo} onChange={handleLogoUpload} className="hidden" />
              </label>
              {logoUrl && (
                <button
                  type="button"
                  onClick={async () => {
                    await apiRequest('/api/masters/company/logo', { method: 'DELETE' });
                    await refreshCompany();
                    await loadAll();
                    setMsg('Logo removed.');
                  }}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs border border-red-200 text-red-700 rounded hover:bg-red-50"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Remove
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create/Edit Item Group Modal */}
      {showGroupModal && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form onSubmit={saveGroup} className="bg-white border border-slate-200 rounded-lg w-full max-w-lg p-6 space-y-3 text-xs">
            <h3 className="text-base font-semibold text-slate-900">{editingGroupId ? 'Edit Item Group' : 'Create Item Group / Sub-Group'}</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Group Name (e.g. RM CAN C.M, CARTON)</label>
                <input required value={groupForm.name} onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })} placeholder="RM CAN C.M" className="w-full px-3 py-1.5 border border-slate-300 rounded" />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Group Code</label>
                <input value={groupForm.group_code} onChange={(e) => setGroupForm({ ...groupForm, group_code: e.target.value })} placeholder="RM-CAN-CM" className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono uppercase" />
              </div>
              <div className="col-span-2">
                <label className="block font-medium text-slate-700 mb-1">Parent Group</label>
                <select value={groupForm.parent_id} onChange={(e) => setGroupForm({ ...groupForm, parent_id: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
                  <option value="">-- Top-Level Parent Group --</option>
                  {categories
                    .filter((c) => c.id !== editingGroupId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.parent_name ? `${c.parent_name} > ` : ''}{c.name} ({c.group_code})
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <input placeholder="Description" value={groupForm.description} onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <div className="flex flex-wrap gap-4 pt-1">
              <label className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={groupForm.is_raw_material} onChange={(e) => setGroupForm({ ...groupForm, is_raw_material: e.target.checked })} />
                <span>Raw Material</span>
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={groupForm.is_packaging} onChange={(e) => setGroupForm({ ...groupForm, is_packaging: e.target.checked })} />
                <span>Packaging</span>
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={groupForm.is_finished_good} onChange={(e) => setGroupForm({ ...groupForm, is_finished_good: e.target.checked })} />
                <span>Finished Good</span>
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowGroupModal(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Save Group</button>
            </div>
          </form>
        </div>
      )}

      {/* Create/Edit Item Modal */}
      {showItemForm && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <form onSubmit={saveItem} className="bg-white border border-slate-200 rounded-lg w-full max-w-2xl p-6 space-y-4 text-xs">
            <h3 className="text-base font-semibold text-slate-900">{editingItemId ? 'Edit Item Master' : 'Create Group-Wise Item'}</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Item Code</label>
                <input required value={itemForm.item_code} onChange={(e) => setItemForm({ ...itemForm, item_code: e.target.value })} placeholder="e.g. CAN-1L-GOLD-CM" className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono uppercase" />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Item Name / Description</label>
                <input required value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} placeholder="e.g. EMPTY CAN (1L) GOLD C.M" className="w-full px-3 py-1.5 border border-slate-300 rounded" />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Parent / Sub-Group</label>
                <select required value={itemForm.category_id} onChange={(e) => setItemForm({ ...itemForm, category_id: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.parent_name ? `${c.parent_name} > ` : ''}{c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Brand / Color / Grade</label>
                <input value={itemForm.brand} onChange={(e) => setItemForm({ ...itemForm, brand: e.target.value })} placeholder="e.g. Gold C.M / API SP" className="w-full px-3 py-1.5 border border-slate-300 rounded" />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Stock UOM</label>
                <select value={itemForm.stock_uom} onChange={(e) => setItemForm({ ...itemForm, stock_uom: e.target.value, purchase_uom: e.target.value, sales_uom: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
                  {uoms.map((u) => <option key={u.code} value={u.code}>{u.code} - {u.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Default Warehouse</label>
                <select value={itemForm.default_warehouse_id} onChange={(e) => setItemForm({ ...itemForm, default_warehouse_id: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
                  <option value="">Select Warehouse</option>
                  {warehouses.map((w) => <option key={String(w.id)} value={String(w.id)}>{String(w.name)}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Standard Cost</label>
                <input type="number" step="0.01" value={itemForm.standard_cost} onChange={(e) => setItemForm({ ...itemForm, standard_cost: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono" />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Selling Price</label>
                <input type="number" step="0.01" value={itemForm.selling_price} onChange={(e) => setItemForm({ ...itemForm, selling_price: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono" />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Reorder Level</label>
                <input type="number" value={itemForm.reorder_level} onChange={(e) => setItemForm({ ...itemForm, reorder_level: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono" />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Min / Max / MOQ</label>
                <div className="grid grid-cols-3 gap-1.5">
                  <input type="number" placeholder="Min" value={itemForm.min_stock} onChange={(e) => setItemForm({ ...itemForm, min_stock: e.target.value })} className="px-2 py-1.5 border border-slate-300 rounded font-mono" />
                  <input type="number" placeholder="Max" value={itemForm.max_stock} onChange={(e) => setItemForm({ ...itemForm, max_stock: e.target.value })} className="px-2 py-1.5 border border-slate-300 rounded font-mono" />
                  <input type="number" placeholder="MOQ" value={itemForm.moq} onChange={(e) => setItemForm({ ...itemForm, moq: e.target.value })} className="px-2 py-1.5 border border-slate-300 rounded font-mono" />
                </div>
              </div>
              <div className="col-span-2">
                <label className="block font-medium text-slate-700 mb-1">Extended Description / Specs (Appears on PO/SO PDFs)</label>
                <input value={itemForm.description} onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })} placeholder="Detailed specification" className="w-full px-3 py-1.5 border border-slate-300 rounded" />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={itemForm.batch_tracking} onChange={(e) => setItemForm({ ...itemForm, batch_tracking: e.target.checked })} />
                <span>Enable Batch & Genealogy Tracking</span>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowItemForm(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 font-medium bg-slate-900 text-white rounded">Save Item</button>
            </div>
          </form>
        </div>
      )}

      {/* Create/Edit Supplier Modal */}
      {showSupForm && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form onSubmit={saveSupplier} className="bg-white border border-slate-200 rounded-lg w-full max-w-lg p-6 space-y-3 text-xs">
            <h3 className="text-base font-semibold text-slate-900">{editingSupId ? 'Edit Supplier' : 'Create Supplier'}</h3>
            <input required placeholder="Supplier Name" value={supForm.name} onChange={(e) => setSupForm({ ...supForm, name: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <input placeholder="Address (Appears on PO PDF)" value={supForm.address} onChange={(e) => setSupForm({ ...supForm, address: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <div className="grid grid-cols-2 gap-3">
              <input placeholder="Contact Person" value={supForm.contact_person} onChange={(e) => setSupForm({ ...supForm, contact_person: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <input placeholder="Country" value={supForm.country} onChange={(e) => setSupForm({ ...supForm, country: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <input placeholder="Email" value={supForm.email} onChange={(e) => setSupForm({ ...supForm, email: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <input placeholder="Telephone" value={supForm.telephone} onChange={(e) => setSupForm({ ...supForm, telephone: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <input placeholder="TRN / VAT Number" value={supForm.trn} onChange={(e) => setSupForm({ ...supForm, trn: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
              <select value={supForm.currency} onChange={(e) => setSupForm({ ...supForm, currency: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded">
                <option value="AED">AED</option><option value="USD">USD</option><option value="EUR">EUR</option>
              </select>
              <input type="number" placeholder="Credit Limit" value={supForm.credit_limit} onChange={(e) => setSupForm({ ...supForm, credit_limit: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowSupForm(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Save Supplier</button>
            </div>
          </form>
        </div>
      )}

      {/* Create/Edit Customer Modal */}
      {showCustForm && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form onSubmit={saveCustomer} className="bg-white border border-slate-200 rounded-lg w-full max-w-lg p-6 space-y-3 text-xs">
            <h3 className="text-base font-semibold text-slate-900">{editingCustId ? 'Edit Customer' : 'Create Customer'}</h3>
            <input required placeholder="Customer Name" value={custForm.name} onChange={(e) => setCustForm({ ...custForm, name: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <input placeholder="Address (Appears on SO & Invoice PDF)" value={custForm.address} onChange={(e) => setCustForm({ ...custForm, address: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <div className="grid grid-cols-2 gap-3">
              <input placeholder="Contact Person" value={custForm.contact_person} onChange={(e) => setCustForm({ ...custForm, contact_person: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <input placeholder="Country" value={custForm.country} onChange={(e) => setCustForm({ ...custForm, country: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <input placeholder="Email" value={custForm.email} onChange={(e) => setCustForm({ ...custForm, email: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <input placeholder="Telephone" value={custForm.telephone} onChange={(e) => setCustForm({ ...custForm, telephone: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <input placeholder="TRN Number" value={custForm.trn} onChange={(e) => setCustForm({ ...custForm, trn: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
              <select value={custForm.currency} onChange={(e) => setCustForm({ ...custForm, currency: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded">
                <option value="AED">AED</option><option value="USD">USD</option><option value="EUR">EUR</option>
              </select>
              <input type="number" placeholder="Credit Limit" value={custForm.credit_limit} onChange={(e) => setCustForm({ ...custForm, credit_limit: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowCustForm(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Save Customer</button>
            </div>
          </form>
        </div>
      )}

      {/* Warehouse Modal */}
      {showWhForm && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form onSubmit={saveWarehouse} className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6 space-y-3 text-xs">
            <h3 className="text-base font-semibold text-slate-900">{editingWhId ? 'Edit Warehouse' : 'Create Warehouse'}</h3>
            <input required placeholder="Warehouse Code (e.g. WH-BO-2)" value={whForm.code} onChange={(e) => setWhForm({ ...whForm, code: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono uppercase" />
            <input required placeholder="Warehouse Name" value={whForm.name} onChange={(e) => setWhForm({ ...whForm, name: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <select value={whForm.warehouse_type} onChange={(e) => setWhForm({ ...whForm, warehouse_type: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
              <option value="Raw Material">Raw Material</option>
              <option value="Tank Farm">Tank Farm</option>
              <option value="Packaging">Packaging</option>
              <option value="Work In Progress">Work In Progress</option>
              <option value="Finished Goods">Finished Goods</option>
              <option value="Quarantine">Quarantine</option>
              <option value="Subcontractor">Subcontractor</option>
            </select>
            <input placeholder="Location / Industrial Zone" value={whForm.location} onChange={(e) => setWhForm({ ...whForm, location: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowWhForm(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Save Warehouse</button>
            </div>
          </form>
        </div>
      )}

      {/* Storage Tank Modal */}
      {showTankForm && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form onSubmit={saveTank} className="bg-white border border-slate-200 rounded-lg w-full max-w-lg p-6 space-y-3 text-xs">
            <h3 className="text-base font-semibold text-slate-900">{editingTankId ? 'Edit Storage Tank' : 'Add Base Oil / Additive Storage Tank'}</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Tank Code</label>
                <input required placeholder="TK-BO-05" value={tankForm.tank_code} onChange={(e) => setTankForm({ ...tankForm, tank_code: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono uppercase" />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Tank Name</label>
                <input required placeholder="Base Oil Tank 5" value={tankForm.name} onChange={(e) => setTankForm({ ...tankForm, name: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Warehouse</label>
                <select required value={tankForm.warehouse_id} onChange={(e) => setTankForm({ ...tankForm, warehouse_id: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
                  {warehouses.map((w) => <option key={String(w.id)} value={String(w.id)}>{String(w.name)}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Tank Type</label>
                <select value={tankForm.tank_type} onChange={(e) => setTankForm({ ...tankForm, tank_type: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
                  <option value="Base Oil">Base Oil</option>
                  <option value="Additive">Additive</option>
                  <option value="Semi-Finished Blend">Semi-Finished Blend</option>
                  <option value="Solvent">Solvent</option>
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Capacity</label>
                <input type="number" step="0.01" required value={tankForm.capacity_qty} onChange={(e) => setTankForm({ ...tankForm, capacity_qty: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono" />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">UOM</label>
                <select value={tankForm.uom} onChange={(e) => setTankForm({ ...tankForm, uom: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
                  {uoms.map((u) => <option key={u.code} value={u.code}>{u.code}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block font-medium text-slate-700 mb-1">Assigned Base Oil / Additive (Optional)</label>
                <select value={tankForm.assigned_item_id} onChange={(e) => setTankForm({ ...tankForm, assigned_item_id: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
                  <option value="">-- Unassigned (Accept Any Compatible Material) --</option>
                  {items.map((it) => (
                    <option key={String(it.id)} value={String(it.id)}>
                      {String(it.item_code)} — {String(it.name)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Min Heel Qty</label>
                <input type="number" step="0.01" value={tankForm.min_heel_qty} onChange={(e) => setTankForm({ ...tankForm, min_heel_qty: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono" />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Operating Temp (°C)</label>
                <input type="number" step="0.1" value={tankForm.temperature_c} onChange={(e) => setTankForm({ ...tankForm, temperature_c: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono" />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowTankForm(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Save Tank</button>
            </div>
          </form>
        </div>
      )}

      {/* Assign Material to Tank Modal */}
      {assignTank && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setErr('');
              try {
                await apiRequest(`/api/masters/tanks/${assignTank.id}/assign`, {
                  method: 'POST',
                  body: JSON.stringify({ item_id: assignItemId ? Number(assignItemId) : null }),
                });
                setAssignTank(null);
                setMsg(`Material assignment updated for tank ${String(assignTank.tank_code)}.`);
                await loadAll();
              } catch (ex: unknown) {
                setErr(ex instanceof Error ? ex.message : 'Failed to assign material');
              }
            }}
            className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6 space-y-3 text-xs"
          >
            <h3 className="text-base font-semibold text-slate-900">Assign Material — {String(assignTank.tank_code)} ({String(assignTank.name)})</h3>
            <p className="text-slate-500">Current Level: {Number(assignTank.current_qty || 0).toLocaleString()} / {Number(assignTank.capacity_qty || 0).toLocaleString()} {String(assignTank.uom)}</p>
            <select value={assignItemId} onChange={(e) => setAssignItemId(e.target.value)} className="w-full px-3 py-1.5 border border-slate-300 rounded">
              <option value="">-- Clear Assignment --</option>
              {items.map((it) => (
                <option key={String(it.id)} value={String(it.id)}>
                  {String(it.item_code)} — {String(it.name)}
                </option>
              ))}
            </select>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setAssignTank(null)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Update Assignment</button>
            </div>
          </form>
        </div>
      )}
      <ExcelImportModal
        open={showImportModal}
        initialType={
          (tab === 'suppliers'
            ? 'suppliers'
            : tab === 'customers'
            ? 'customers'
            : tab === 'warehouses'
            ? 'tanks'
            : 'items') as ImportType
        }
        onClose={() => setShowImportModal(false)}
        onImported={(m) => {
          setMsg(m);
          void loadAll();
        }}
      />
    </div>
  );
}
