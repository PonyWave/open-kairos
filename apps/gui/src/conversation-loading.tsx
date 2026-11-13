import { DelayedStatus } from './delayed-status.js';

export function ConversationLoading() {
  return (
    <div className="conversation-loading" role="status" aria-label="正在加载消息">
      <span className="sr-only">正在加载消息…</span>
      <DelayedStatus delay={180}>
        <div className="conversation-skeleton" aria-hidden="true">
          <div className="skeleton-user">
            <span />
          </div>
          <div className="skeleton-reply">
            <span className="skeleton-avatar" />
            <div className="skeleton-lines">
              <span />
              <span />
              <span />
            </div>
          </div>
          <div className="skeleton-user skeleton-user-short">
            <span />
          </div>
          <div className="skeleton-reply">
            <span className="skeleton-avatar" />
            <div className="skeleton-lines">
              <span />
              <span />
            </div>
          </div>
        </div>
      </DelayedStatus>
    </div>
  );
}
