export interface User {
  id: number;
  username: string;
  email: string;
  full_name: string;
  role_id: number;
  role_name: string;
  department: string;
}

export interface RolePermission {
  id: number;
  role_id: number;
  module: string;
  doc_type: string;
  can_view: number;
  can_create: number;
  can_edit: number;
  can_delete: number;
  can_submit: number;
  can_cancel: number;
  can_amend: number;
  can_approve: number;
  can_export: number;
  can_print: number;
}

export interface CompanyProfile {
  id?: number;
  name: string;
  short_name?: string;
  logo_path?: string;
  logo_url?: string;
  address?: string;
  po_box?: string;
  country?: string;
  trn?: string;
  telephone?: string;
  email?: string;
  website?: string;
  currency: string;
  vat_rate: number;
  vat_enabled?: number;
  financial_year_start?: string;
  financial_year_end?: string;
  letterhead_html?: string;
}

export type ModuleKey =
  | 'dashboard'
  | 'masters'
  | 'procurement'
  | 'inventory'
  | 'manufacturing'
  | 'quality'
  | 'sales'
  | 'accounting'
  | 'operations'
  | 'approvals'
  | 'settings';

export interface NotificationItem {
  id: number;
  type: string;
  title: string;
  message: string;
  doc_type: string;
  doc_id: number | null;
  is_read: number;
  created_at: string;
}

export interface SearchResult {
  type: string;
  id: number;
  number: string;
  title: string;
  subtitle: string;
  module: ModuleKey;
}
