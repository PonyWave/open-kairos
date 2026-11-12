export interface Identity {
  userId: string;
  email: string;
  username: string;
  tenantId: string;
  mainThreadId: string;
  avatarId?: string;
  profileVersion?: number;
}

export interface IssuedCredential {
  token: string;
  expiresAt: string;
}

export type VerifiedAuthentication =
  | { kind: 'profile_required'; credential: IssuedCredential }
  | { kind: 'authenticated'; credential: IssuedCredential; identity: Identity };
