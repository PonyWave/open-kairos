export interface Identity {
  userId: string;
  email: string;
  username: string;
  tenantId: string;
  mainThreadId: string;
  avatarId?: string;
  profileVersion?: number;
}
