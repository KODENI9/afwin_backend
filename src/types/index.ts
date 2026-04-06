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
  MANAGE_NETWORKS = 'MANAGE_NETWORKS',
  VIEW_DRAWS = 'VIEW_DRAWS',
  VIEW_BASIC_STATS = 'VIEW_BASIC_STATS',
  MANAGE_FLASH = 'MANAGE_FLASH', // ← nouveau
}

export interface UserProfile {
  id?: string;
  user_id: string;
  display_name: string;
  balance: number;
  role: UserRole | string;
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
  draw_date: string;
  slotId: string;
  startTime: string;
  endTime: string;
  status: 'OPEN' | 'CLOSED' | 'RESOLVED';
  totalPool: number;
  multiplier: number;
  commissionRate?: number;
  winningNumber?: number;
  snapshotTotals?: Record<number, number>;
  snapshotHash?: string;
  closedAt?: string;
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

/**
 * Flash Draw — mini-tirage de durée courte lancé manuellement ou automatiquement.
 * Stocké dans la collection `flash_draws`.
 */
export interface FlashDraw {
  id?: string;
  type: 'flash';                          // discriminant pour le frontend
  label: string;                          // ex: "⚡ Flash 18h30"
  durationMinutes: number;               // durée en minutes (ex: 5)
  startTime: string;                     // ISO — quand le Flash commence
  endTime: string;                       // ISO — calculé: startTime + durationMinutes
  status: 'OPEN' | 'CLOSED' | 'RESOLVED';
  multiplier: number;                    // défini par l'admin à la création
  realMultiplier?: number;
  totalPool: number;
  winningNumber?: number;
  snapshotTotals?: Record<number, number>;
  snapshotHash?: string;
  closedAt?: string;
  resolvedAt?: string;
  payoutStatus?: 'PENDING' | 'PROCESSING' | 'COMPLETED';
  totalPayout?: number;
  profit?: number;
  locked?: boolean;
  createdBy: string;                     // adminId ou 'system'
  createdAt: string;
  updated_at?: string;
  // Plages horaires auto (si créé par le scheduler)
  autoSchedule?: boolean;
}

/**
 * Configuration des plages horaires Flash (stockée dans settings/flash_config).
 */
export interface FlashScheduleConfig {
  enabled: boolean;
  slots: FlashTimeSlot[];
}

export interface FlashTimeSlot {
  id: string;              // ex: "FS1"
  startHour: number;      // ex: 9  (09:00)
  startMinute: number;    // ex: 30 (09:30)
  durationMinutes: number; // ex: 5
  multiplier: number;     // ex: 8
  label: string;          // ex: "Flash Matinal"
  enabled: boolean;
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
  updated_at?: string;
  resolvedAt?: string;
  metadata?: any;
}

export interface Transaction {
  id?: string;
  user_id: string;
  draw_id?: string;
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

export interface GlobalNotification {
  id?: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning';
  target?: 'all' | 'user';
  targetUserId?: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdBy: string;
  validatedBy?: string;
  rejectionReason?: string;
  createdAt: string;
  validatedAt?: string;
}

export interface Network {
  id?: string;
  name: string;
  ussd_template: string;
  destination_number: string;
  is_active: boolean;
  order: number;
}