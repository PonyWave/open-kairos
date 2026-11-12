import { ReplyPreviews } from './delegation-cards.js';
import { Dropdown } from './dropdown.js';
import { EntityMark } from './entity-mark.js';
import { FailureNotice } from './failure-notice.js';
import { Icon } from './icon.js';
import type { TopicSort } from './thread-preview-gateway.js';
import type { TopicCardView } from './thread-view.js';
import { formatAbsoluteDateTime, formatMessageTime, timestampDate } from './time-format.js';

export function ThreadListPage({
  cards,
  sort,
  mainThreadId,
  loading,
  error,
  hasMore,
  onOpen,
  onSort,
  onLoadMore,
  onReload,
}: {
  cards: readonly TopicCardView[];
  sort: TopicSort;
  mainThreadId: string | null;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  onOpen: (card: TopicCardView) => void;
  onSort: (sort: TopicSort) => void;
  onLoadMore: () => Promise<void>;
  onReload: () => Promise<void>;
}) {
  return (
    <section
      className="thread-directory conversation-list-page"
      aria-labelledby="thread-directory-heading"
    >
      <header className="page-heading">
        <div>
          <h1 id="thread-directory-heading">全部对话</h1>
        </div>
        <Dropdown<TopicSort>
          className="conversation-sort"
          triggerClassName="sort-trigger"
          label="排序字段"
          value={sort}
          align="end"
          trigger={
            <>
              <Icon name="history" className="i-sm" />
              <span>{sort === 'createdAt' ? '创建时间' : '更新时间'}</span>
              <Icon name="down" className="i-sm dropdown-chevron" />
            </>
          }
          items={[
            { value: 'lastMessageAt', label: '更新时间' },
            { value: 'createdAt', label: '创建时间' },
          ]}
          onSelect={onSort}
        />
      </header>
      {error && (
        <FailureNotice
          label="列表加载失败"
          message={error}
          busy={loading}
          onRetry={() => void onReload()}
        />
      )}
      {loading && cards.length === 0 ? (
        <p role="status">正在加载全部对话</p>
      ) : cards.length === 0 && !error ? (
        <p className="empty">当前没有话题。</p>
      ) : (
        <section className="conversation-list" aria-label="全部话题">
          {cards.map((card) => (
            <TopicCard
              key={card.thread.threadId}
              card={card}
              sort={sort}
              mainThreadId={mainThreadId}
              onOpen={onOpen}
            />
          ))}
        </section>
      )}
      {hasMore && (
        <button
          type="button"
          className="thread-directory-more"
          disabled={loading}
          onClick={() => void onLoadMore()}
        >
          {loading ? '正在加载下一页' : '加载更多对话'}
        </button>
      )}
    </section>
  );
}

export function TopicCard({
  card,
  sort,
  mainThreadId,
  onOpen,
}: {
  card: TopicCardView;
  sort: TopicSort;
  mainThreadId?: string | null | undefined;
  onOpen: (card: TopicCardView) => void;
}) {
  const timestamp = sort === 'createdAt' ? card.createdAt : card.lastMessageAt;
  const time = timestamp ? formatMessageTime(timestamp) : '暂无消息时间';
  const date = timestampDate(timestamp);
  return (
    <button
      type="button"
      className="conversation-card"
      onClick={() => onOpen(card)}
      aria-label={`打开话题 ${card.thread.title}，${sort === 'createdAt' ? '创建时间' : '最后消息'} ${time}`}
    >
      <span className="conversation-card-heading">
        <span className="conversation-card-title">
          <EntityMark threadId={card.thread.threadId} />
          <strong>{card.thread.title || '未命名话题'}</strong>
        </span>
        <time
          dateTime={date?.toISOString()}
          title={date ? formatAbsoluteDateTime(date) : undefined}
        >
          {time}
        </time>
      </span>
      <ReplyPreviews
        replies={card.replies}
        threadId={card.thread.threadId}
        mainThreadId={mainThreadId}
      />
      <span className="conversation-card-footer">
        <Icon name="chat" className="i-sm" />
        <span>查看话题</span>
        <Icon name="chevron" className="i-sm" />
      </span>
    </button>
  );
}
