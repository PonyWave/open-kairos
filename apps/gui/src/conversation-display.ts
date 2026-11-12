import type { StorageLike } from './actions.js';

export type ConversationDisplayMode = 'compact' | 'full';

export interface ConversationDisplayPreference {
  mode: ConversationDisplayMode;
  error: string | null;
}

const preferenceKey = 'kairos.conversation-display.v1';

export function loadConversationDisplay(
  storage: StorageLike | undefined,
): ConversationDisplayPreference {
  try {
    const value = storage?.getItem(preferenceKey);
    return { mode: value === 'full' ? 'full' : 'compact', error: null };
  } catch {
    return { mode: 'compact', error: '无法读取主对话显示设置，当前使用精简视图。' };
  }
}

export function saveConversationDisplay(
  storage: StorageLike | undefined,
  mode: ConversationDisplayMode,
): ConversationDisplayPreference {
  try {
    if (!storage) throw new Error('Local storage is unavailable.');
    storage.setItem(preferenceKey, mode);
    return { mode, error: null };
  } catch {
    return { mode, error: '已在当前页面应用，但无法保存显示设置；刷新后可能恢复原值。' };
  }
}
