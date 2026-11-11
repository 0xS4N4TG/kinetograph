// The UI event constructors a library names at import or mount (`PointerEvent`, `MouseEvent`, `WheelEvent`): spec-shaped
// classes over Node's `Event`, with the init dictionaries of the UI Events and Pointer Events specs. Nothing in the engine
// dispatches them; a script `new`s one and calls `dispatchEvent`.

export interface UIEventInit extends EventInit {
  view?: unknown;
  detail?: number;
}

export class UIEventShim extends Event {
  readonly view: unknown;
  readonly detail: number;
  constructor(type: string, init: UIEventInit = {}) {
    super(type, init);
    this.view = init.view ?? null;
    this.detail = init.detail ?? 0;
  }
}

export interface MouseEventInit extends UIEventInit {
  screenX?: number;
  screenY?: number;
  clientX?: number;
  clientY?: number;
  movementX?: number;
  movementY?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  button?: number;
  buttons?: number;
  relatedTarget?: unknown;
}

export class MouseEventShim extends UIEventShim {
  readonly screenX: number;
  readonly screenY: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly movementX: number;
  readonly movementY: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly button: number;
  readonly buttons: number;
  readonly relatedTarget: unknown;
  constructor(type: string, init: MouseEventInit = {}) {
    super(type, init);
    this.screenX = init.screenX ?? 0;
    this.screenY = init.screenY ?? 0;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.movementX = init.movementX ?? 0;
    this.movementY = init.movementY ?? 0;
    this.ctrlKey = init.ctrlKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
    this.altKey = init.altKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.button = init.button ?? 0;
    this.buttons = init.buttons ?? 0;
    this.relatedTarget = init.relatedTarget ?? null;
  }
  // Nothing scrolls, so the page and viewport coordinates agree.
  get x(): number {
    return this.clientX;
  }
  get y(): number {
    return this.clientY;
  }
  get pageX(): number {
    return this.clientX;
  }
  get pageY(): number {
    return this.clientY;
  }
  get offsetX(): number {
    return this.clientX;
  }
  get offsetY(): number {
    return this.clientY;
  }
  getModifierState(key: string): boolean {
    switch (key) {
      case 'Control': return this.ctrlKey;
      case 'Shift': return this.shiftKey;
      case 'Alt': return this.altKey;
      case 'Meta': return this.metaKey;
      default: return false;
    }
  }
}

export interface PointerEventInit extends MouseEventInit {
  pointerId?: number;
  width?: number;
  height?: number;
  pressure?: number;
  tangentialPressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  pointerType?: string;
  isPrimary?: boolean;
}

export class PointerEventShim extends MouseEventShim {
  readonly pointerId: number;
  readonly width: number;
  readonly height: number;
  readonly pressure: number;
  readonly tangentialPressure: number;
  readonly tiltX: number;
  readonly tiltY: number;
  readonly twist: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.width = init.width ?? 1;
    this.height = init.height ?? 1;
    this.pressure = init.pressure ?? 0;
    this.tangentialPressure = init.tangentialPressure ?? 0;
    this.tiltX = init.tiltX ?? 0;
    this.tiltY = init.tiltY ?? 0;
    this.twist = init.twist ?? 0;
    this.pointerType = init.pointerType ?? '';
    this.isPrimary = init.isPrimary ?? false;
  }
  getCoalescedEvents(): PointerEventShim[] {
    return [];
  }
  getPredictedEvents(): PointerEventShim[] {
    return [];
  }
}

export interface WheelEventInit extends MouseEventInit {
  deltaX?: number;
  deltaY?: number;
  deltaZ?: number;
  deltaMode?: number;
}

export class WheelEventShim extends MouseEventShim {
  static readonly DOM_DELTA_PIXEL = 0;
  static readonly DOM_DELTA_LINE = 1;
  static readonly DOM_DELTA_PAGE = 2;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaZ: number;
  readonly deltaMode: number;
  constructor(type: string, init: WheelEventInit = {}) {
    super(type, init);
    this.deltaX = init.deltaX ?? 0;
    this.deltaY = init.deltaY ?? 0;
    this.deltaZ = init.deltaZ ?? 0;
    this.deltaMode = init.deltaMode ?? 0;
  }
}
