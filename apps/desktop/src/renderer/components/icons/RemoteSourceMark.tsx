/**
 * RemoteSourceMark —— 「另一台电脑上的供应商」图标。
 *
 * 品牌图形缩到左下，右上角用一道波纹加一个点标出远端：仍是**一个**图标位，
 * 一眼读出「这个供应商，在远处」。不在 Logo 旁边另放电脑图标(2026-10-06 用户裁决)。
 *
 * 几何(16 单位画布):品牌占左下 12.5 × 12.5，波纹从品牌右上角向外发出，
 * 点落在连接角内。颜色全部跟随 currentColor，Light / Dark 由外层文字色决定。
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** 品牌图形在 16 单位画布里所占边长(左下对齐)。 */
const BRAND_UNITS = 12.5;

export function RemoteSourceMark({
  size,
  markSize = 13,
  className,
  children,
}: {
  /** 整个图标(品牌 + 波纹)的边长，px。 */
  size: number;
  /** children 渲染时的原生边长，px；按比例缩进品牌区。 */
  markSize?: number;
  className?: string;
  /** 品牌图形(ProviderMark / ModelIconMark 等，颜色请用 currentColor)。 */
  children: ReactNode;
}) {
  const scale = (size * BRAND_UNITS) / 16 / markSize;
  return (
    <span
      aria-hidden
      data-remote-source-mark
      className={cn('relative inline-block shrink-0', className)}
      style={{ width: size, height: size }}
    >
      <span
        className="absolute bottom-0 left-0 flex items-end justify-start"
        style={{
          width: markSize,
          height: markSize,
          transform: `scale(${scale})`,
          transformOrigin: 'left bottom',
        }}
      >
        {children}
      </span>
      <svg
        viewBox="0 0 16 16"
        width={size}
        height={size}
        className="absolute inset-0"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
      >
        <path d="M12 1.4A2.6 2.6 0 0 1 14.6 4" />
        <circle cx="12.6" cy="3.4" r="0.95" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}
