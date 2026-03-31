export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
  SUPER_ADMIN = 'super_admin'
}

export enum AdminPermission {
  VIEW_DASHBOARD = 'VIEW_DASHBOARD',
  VIEW_USERS = 'VIEW_USERS',
  MANAGE_USERS = 'MANAGE_USERS',
  MANAGE_DRAWS = 'MANAGE_DRAWS',
  VIEW_FINANCIALS = 'VIEW_FINANCIALS',
  VIEW_PROFIT = 'VIEW_PROFIT',
  VIEW_ADVANCED_STATS = 'VIEW_ADVANCED_STATS',
  SEND_GLOBAL_NOTIFICATION = 'SEND_GLOBAL_NOTIFICATION',
  VIEW_AUDIT_LOGS = 'VIEW_AUDIT_LOGS',
  MANAGE_SETTINGS = 'MANAGE_SETTINGS',
  MANAGE_NETWORKS = 'MANAGE_NETWORKS'
}

export interface UserProfile {
  id?: string;
  user_id: string; // Clerk user ID
  display_name: string;
  balance: number;
  role: UserRole | string; // Support legacy strings during migration
  permissions?: AdminPermission[] | string[];
  referral_code: string;
  referred_by?: string;
  phone?: string;
  email?: string;
  pin_code?: string;
  first_deposit_approved?: boolean;
  is_blocked?: boolean;
  created_at: string;
  updated_at: string;
}

export interface Draw {
  id?: string;
  draw_date: string; // YYYY-MM-DD (legacy/grouping)
  slotId: string; // S1, S2, etc.
  startTime: string; // ISO string
  endTime: string; // ISO string
  status: 'OPEN' | 'CLOSED' | 'RESOLVED';
  totalPool: number;
  multiplier: number; // e.g. 5
  commissionRate?: number; // e.g. 0.10
  winningNumber?: number;
  snapshotTotals?: Record<number, number>; // {1: 1000, 2: 500, ...}
  snapshotHash?: string; // SHA256 of snapshotTotals
  resolvedAt?: string;
  payoutStatus?: 'PENDING' | 'PROCESSING' | 'COMPLETED';
  totalPayout?: number;
  commission?: number;
  profit?: number;
  totalPayoutDistributed?: number;
  locked?: boolean;
  realMultiplier?: number;
  created_at: string;
  updated_at?: string;
}

export interface Bet {
  id?: string;
  user_id: string;
  draw_id: string;
  number: number;
  amount: number;
  status: 'PENDING' | 'WON' | 'LOST';
  payoutAmount: number;
  createdAt: string;
  resolvedAt?: string;
}

export interface Transaction {
  id?: string;
  user_id: string;
  draw_id?: string; // Associated draw for payouts/bets
  type: 'deposit' | 'withdrawal' | 'bet' | 'payout' | 'commission' | 'referral_bonus' | 'transfer_sent' | 'transfer_received';
  amount: number;
  provider: string;
  reference?: string;
  sms_content?: string;
  account_details?: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id?: string;
  user_id: string;
  title: string;
  message: string;
  type: 'win' | 'info' | 'system';
  read: boolean;
  created_at: string;
}

export interface Network {
  id?: string;
  name: string;
  ussd_template: string;
  destination_number: string;
  is_active: boolean;
  order: number;
}
