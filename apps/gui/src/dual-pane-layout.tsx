import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

export function DualPaneLayout({
  mainVisible,
  hasTopic,
  narrowViewport = false,
  children,
}: {
  mainVisible: boolean;
  hasTopic: boolean;
  narrowViewport?: boolean;
  children?: ReactNode;
}) {
  const panes = Children.map(children, (child, index) => {
    if (index !== 0 || !isValidElement(child)) return child;
    return cloneElement(child as ReactElement<{ hidden?: boolean }>, {
      hidden: !mainVisible || (hasTopic && narrowViewport),
    });
  });
  return (
    <div
      className={`session-layout${hasTopic && mainVisible ? ' with-topic' : ''}`}
      hidden={!mainVisible}
      data-main-mounted="true"
      data-topic-open={hasTopic && mainVisible ? 'true' : 'false'}
    >
      {panes}
    </div>
  );
}
