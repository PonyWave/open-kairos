import { ChannelDeliveryStatus } from '@kairos/contracts';
import { useEffect, useState } from 'react';
import type { KairosClients } from './client.js';
import type { ChannelDeliveryStatusInfo } from './sent-user-message.js';

const pollIntervalMs = 3_000;

export function useChannelDeliveries(
  clients: KairosClients,
  deliveryIds: readonly string[],
): ReadonlyMap<string, ChannelDeliveryStatusInfo> {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, ChannelDeliveryStatusInfo>>(
    new Map(),
  );
  const key = deliveryIds.join('\n');
  useEffect(() => {
    const ids = key.length === 0 ? [] : key.split('\n');
    if (ids.length === 0) {
      setStatuses(new Map());
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await clients.channels.listChannelDeliveries({ deliveryIds: ids });
        if (cancelled) return;
        const next = new Map<string, ChannelDeliveryStatusInfo>();
        for (const delivery of response.deliveries) {
          next.set(delivery.deliveryId, {
            status:
              delivery.status === ChannelDeliveryStatus.SUCCEEDED
                ? 'succeeded'
                : delivery.status === ChannelDeliveryStatus.FAILED
                  ? 'failed'
                  : delivery.status === ChannelDeliveryStatus.DELIVERING
                    ? 'delivering'
                    : 'pending',
            errorMessage: delivery.errorMessage,
          });
        }
        setStatuses(next);
        if (
          response.deliveries.some(
            (delivery) =>
              delivery.status === ChannelDeliveryStatus.PENDING ||
              delivery.status === ChannelDeliveryStatus.DELIVERING,
          )
        ) {
          timer = setTimeout(() => void load(), pollIntervalMs);
        }
      } catch {
        // 投递状态查询失败不影响消息展示。
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [clients, key]);
  return statuses;
}
