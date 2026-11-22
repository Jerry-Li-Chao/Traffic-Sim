import type { InputHandler } from '../game/Input';
import type { World } from '../world/World';
import type { NetGeometry } from '../world/geometry';
import type { OverlayLayer } from '../render/OverlayLayer';
import type { CameraModel } from '../render/camera';
import type { MapBounds } from '../world/build';

export interface ToolContext {
  world: World;
  geom: NetGeometry;
  overlay: OverlayLayer;
  cam: CameraModel;
  map: MapBounds;
  money(): number;
  unlimited(): boolean;
  /**
   * Run a world mutation as one undoable command. `cost` is charged (negative = refund).
   * Returns false if the command threw (world is restored). With `merge`, the change joins the
   * previous undo step (e.g. everything removed in one bulldozer drag undoes together).
   */
  commit(label: string, cost: number, fn: () => void, opts?: { merge?: boolean }): boolean;
  /** CSS cursor for the game view (null = default) */
  setCursor(cursor: string | null): void;
  /** notify that selection/inspection changed */
  select(sel: { kind: 'segment' | 'node' | 'vehicle'; id: number } | null): void;
  pickVehicle(p: { x: number; y: number }): number | null;
}

export interface Tool extends InputHandler {
  id: string;
  activate?(): void;
  deactivate?(): void;
  /** called after the world changes (geometry rebuilt) */
  refresh?(): void;
}
