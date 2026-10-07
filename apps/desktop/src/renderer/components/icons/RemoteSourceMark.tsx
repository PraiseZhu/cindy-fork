/**
 * RemoteSourceMark —— 「另一台电脑上的供应商」图标。
 *
 * 品牌图形缩到左下，右上角用一道波纹加一个点标出远端：仍是**一个**图标位，
 * 一眼读出「这个供应商，在远处」。不在 Logo 旁边另放电脑图标(2026-10-06 用户裁决)。
 *
 * 几何(16 单位画布):品牌占左下 12.5 × 12.5，波纹从品牌右上角向外发出，
 * 点落在连接角内。颜色全部跟随 currentColor，Light / Dark 由外层文字色决定。
 *
 * 侧栏等处的 Agent 图标(Agent 在另一台电脑运行)用同一道波纹，但图形不缩放、
 * 不移位，见 RemoteSignalOverlay。
 */
import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** 品牌图形在 16 单位画布里所占边长(左下对齐)。 */
const BRAND_UNITS = 12.5;
/** 品牌区右上角在 16 单位画布里的纵坐标。 */
const BRAND_TOP_UNITS = 16 - BRAND_UNITS;

/** 波纹 + 点本体(16 单位画布)。远程供应商 Logo 与远程 Agent 图标共用这一笔。 */
function RemoteSignal({
  size,
  className,
  style,
}: {
  size: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={className}
      style={style}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M12 1.4A2.6 2.6 0 0 1 14.6 4" />
      <circle cx="12.6" cy="3.4" r="0.95" fill="currentColor" stroke="none" />
    </svg>
  );
}

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
      <RemoteSignal size={size} className="absolute inset-0" />
    </span>
  );
}

/**
 * 给原位、原大小的图形叠同一道波纹:图形本身不缩放不移位(同列图标照旧对齐)，
 * 波纹画到图形右上角外侧。把图形当作品牌区，几何与 RemoteSourceMark 一致。
 *
 * anchorX / anchorY 是图形笔画右上角在自身方框里的位置(0–1):像素脸、花形这类
 * 不顶满方框的图形按实际笔画给，波纹才贴着图形而不是悬在方框角上。
 * 父级需要 `relative`，且不能裁剪溢出。
 */
export function RemoteSignalOverlay({
  markSize,
  anchorX = 1,
  anchorY = 0,
}: {
  /** 被叠加图形的边长，px。 */
  markSize: number;
  anchorX?: number;
  anchorY?: number;
}) {
  const unit = markSize / BRAND_UNITS;
  return (
    <RemoteSignal
      size={unit * 16}
      className="pointer-events-none absolute"
      style={{
        left: (anchorX - 1) * markSize,
        top: anchorY * markSize - BRAND_TOP_UNITS * unit,
      }}
    />
  );
}
