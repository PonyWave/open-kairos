import type { Identity } from '@kairos/contracts';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import type { KairosClients } from './client.js';

const UserProfile = createContext<{ username: string; avatarUrl: string | null }>({
  username: '用户',
  avatarUrl: null,
});

export function usernameInitial(username: string): string {
  return (
    new Intl.Segmenter('zh', { granularity: 'grapheme' })
      .segment(username.trim())
      [Symbol.iterator]()
      .next().value?.segment ?? '用'
  );
}

export function UserProfileProvider({
  identity,
  clients,
  children,
}: {
  identity: Identity;
  clients: Pick<KairosClients, 'settings'>;
  children?: ReactNode;
}) {
  const [avatar, setAvatar] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    const id = identity.avatarId;
    setAvatar(null);
    if (id)
      void clients.settings
        .readAvatar({ avatarId: id }, { signal: controller.signal })
        .then((response) => {
          if (controller.signal.aborted) return;
          objectUrl = URL.createObjectURL(
            new Blob([new Uint8Array(response.content)], { type: response.mediaType }),
          );
          setAvatar({ id, url: objectUrl });
        })
        .catch(() => {
          /* A missing or unavailable image uses the username initial. */
        });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [identity.avatarId, clients.settings]);
  return (
    <UserProfile.Provider
      value={{
        username: identity.username,
        avatarUrl: avatar && avatar.id === identity.avatarId ? avatar.url : null,
      }}
    >
      {children}
    </UserProfile.Provider>
  );
}

export function UserAvatar({
  className = '',
  previewUrl,
  username,
}: {
  className?: string;
  previewUrl?: string | null | undefined;
  username?: string;
}) {
  const profile = useContext(UserProfile);
  const name = username ?? profile.username;
  const url = previewUrl === undefined ? profile.avatarUrl : previewUrl;
  return (
    <span className={`user-avatar ${className}`} role="img" aria-label={name}>
      {url ? <img src={url} alt="" /> : usernameInitial(name)}
    </span>
  );
}
