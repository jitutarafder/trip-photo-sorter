import type { ViewProps } from 'react-native';
import type React from 'react';

export interface SvgProps extends ViewProps {
  color?: string;
  stroke?: string;
  strokeWidth?: number | string;
  fill?: string;
  size?: number | string;
  width?: number | string;
  height?: number | string;
  [key: string]: any;
}

export declare const Svg: React.ComponentType<SvgProps>;
export declare const Path: React.ComponentType<any>;
export declare const Circle: React.ComponentType<any>;
export declare const Rect: React.ComponentType<any>;
export declare const Line: React.ComponentType<any>;
export declare const Polyline: React.ComponentType<any>;
export declare const Polygon: React.ComponentType<any>;
export declare const G: React.ComponentType<any>;
export declare const Text: React.ComponentType<any>;
export declare const Defs: React.ComponentType<any>;
export declare const LinearGradient: React.ComponentType<any>;
export declare const Stop: React.ComponentType<any>;

export default Svg;
