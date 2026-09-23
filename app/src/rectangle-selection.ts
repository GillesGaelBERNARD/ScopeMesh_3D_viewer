export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function normalizedRect(startX: number, startY: number, endX: number, endY: number): ScreenRect {
  return {
    left: Math.min(startX, endX),
    top: Math.min(startY, endY),
    right: Math.max(startX, endX),
    bottom: Math.max(startY, endY),
  };
}

export function rectanglesIntersect(a: ScreenRect, b: ScreenRect): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

