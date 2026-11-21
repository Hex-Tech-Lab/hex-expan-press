declare module "page-flip" {
  export type SizeType = "fixed" | "stretch";
  export type FlipCorner = "top" | "bottom";
  export type Orientation = "portrait" | "landscape";

  export interface FlipSetting {
    startPage?: number;
    size?: SizeType;
    width: number;
    height: number;
    minWidth?: number;
    maxWidth?: number;
    minHeight?: number;
    maxHeight?: number;
    drawShadow?: boolean;
    flippingTime?: number;
    usePortrait?: boolean;
    startZIndex?: number;
    autoSize?: boolean;
    maxShadowOpacity?: number;
    showCover?: boolean;
    mobileScrollSupport?: boolean;
    clickEventForward?: boolean;
    useMouseEvents?: boolean;
    swipeDistance?: number;
    showPageCorners?: boolean;
    disableFlipByClick?: boolean;
  }

  export interface PageFlipEvent {
    data: number | string | { page: number; mode: Orientation };
    object: PageFlip;
  }

  export class PageFlip {
    constructor(inBlock: HTMLElement, setting: FlipSetting);
    loadFromImages(imagesHref: string[]): void;
    loadFromHTML(items: NodeListOf<HTMLElement> | HTMLElement[]): void;
    updateFromImages(imagesHref: string[]): void;
    updateFromHtml(items: NodeListOf<HTMLElement> | HTMLElement[]): void;
    flipNext(corner?: FlipCorner): void;
    flipPrev(corner?: FlipCorner): void;
    flip(pageNum: number, corner?: FlipCorner): void;
    turnToNextPage(): void;
    turnToPrevPage(): void;
    turnToPage(pageNum: number): void;
    getPageCount(): number;
    getOrientation(): Orientation;
    getCurrentPageIndex(): number;
    /** The DOM UI layer. Its `update()` re-syncs the canvas bitmap to the container's CSS box. */
    getUI(): { update(): void };
    on(eventName: "flip" | "changeOrientation" | "changeState" | "init" | "update", callback: (e: PageFlipEvent) => void): void;
    destroy(): void;
  }
}
