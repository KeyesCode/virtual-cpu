import { useLayoutEffect, useRef } from 'react';

/** How close to the bottom (px) still counts as following the newest row. */
const FOLLOW_SLACK = 24;

/**
 * Keeps a scroll container pinned to its bottom when `key` changes (a new row arrived), unless
 * the reader has scrolled up to look at older rows.
 */
export function useStickToBottom<T extends HTMLElement>(key: unknown) {
  const ref = useRef<T>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element !== null && following.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [key]);
  const onScroll = (): void => {
    const element = ref.current;
    if (element === null) return;
    following.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK;
  };
  return { ref, onScroll };
}
