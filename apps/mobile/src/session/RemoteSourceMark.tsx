/**
 * RemoteSourceMark —— 「另一台电脑上的供应商」图标(移植自桌面
 * apps/desktop/src/renderer/components/icons/RemoteSourceMark.tsx)。
 *
 * 品牌图形缩到左下 12.5 / 16,右上角用一道波纹加一个点标出远端:仍是**一个**图标位,
 * 一眼读出「这个供应商,在远处」。不在 Logo 旁另放电脑图标(2026-10-06 用户裁决)。
 * 波纹与点跟随 color(缺省 textSecondary,与供应商 mark 同色),Light / Dark 走主题 token。
 */
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { useTheme } from '@/theme';

/** 品牌图形在 16 单位画布里所占边长(左下对齐)。 */
const BRAND_UNITS = 12.5;
/** MobileProviderMark / MobileModelIconMark 的原生盒边长。 */
const DEFAULT_MARK_SIZE = 18;

export function RemoteSourceMark({
  size,
  markSize = DEFAULT_MARK_SIZE,
  color,
  children,
  testID,
}: {
  /** 整个图标(品牌 + 波纹)的边长。 */
  size: number;
  /** children 的原生边长;按比例缩进品牌区。 */
  markSize?: number;
  color?: string;
  /** 品牌图形(MobileProviderMark 等)。 */
  children: ReactNode;
  testID?: string;
}) {
  const { colors } = useTheme();
  const stroke = color ?? colors.textSecondary;
  const scale = (size * BRAND_UNITS) / 16 / markSize;
  // RN 的 scale 以盒中心为原点:缩放后再平移,让品牌贴住左下角。
  const offset = (markSize * (1 - scale)) / 2;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ height: size, width: size }}
      testID={testID}
    >
      <View
        style={[
          styles.brand,
          {
            height: markSize,
            width: markSize,
            transform: [{ translateX: -offset }, { translateY: offset }, { scale }],
          },
        ]}
      >
        {children}
      </View>
      <Svg height={size} style={StyleSheet.absoluteFill} viewBox="0 0 16 16" width={size}>
        {/* 波纹描边是 16 单位画布里的图形几何(与桌面同值、随 size 缩放),不是阶梯图标描边。 */}
        <Path
          d="M12 1.4A2.6 2.6 0 0 1 14.6 4"
          fill="none"
          stroke={stroke}
          strokeLinecap="round"
          strokeWidth={1.4}
        />
        <Circle cx={12.6} cy={3.4} fill={stroke} r={0.95} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  brand: {
    alignItems: 'flex-start',
    bottom: 0,
    justifyContent: 'flex-end',
    left: 0,
    position: 'absolute',
  },
});
