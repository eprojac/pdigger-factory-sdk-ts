/** A 2-D context that records every call and style change, for drawing tests without a canvas. */
export class RecordingContext {
  readonly calls: { op: string; args: unknown[] }[] = [];
  canvas = { width: 960, height: 540 };
  private state: Record<string, unknown> = {
    strokeStyle: "#000",
    fillStyle: "#000",
    lineWidth: 1,
    globalAlpha: 1,
    font: "10px sans-serif",
    textBaseline: "alphabetic",
    lineJoin: "miter",
    lineCap: "butt",
  };
  private readonly stack: Record<string, unknown>[] = [];

  private rec(op: string, ...args: unknown[]): void {
    this.calls.push({ op, args });
  }

  /** The ops recorded, e.g. `["save", "setTransform", ...]`. */
  ops(): string[] {
    return this.calls.map((c) => c.op);
  }

  count(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  save(): void {
    this.stack.push({ ...this.state });
    this.rec("save");
  }
  restore(): void {
    this.state = this.stack.pop() ?? this.state;
    this.rec("restore");
  }
  setTransform(...args: number[]): void {
    this.rec("setTransform", ...args);
  }
  transform(...args: number[]): void {
    this.rec("transform", ...args);
  }
  clearRect(...args: number[]): void {
    this.rec("clearRect", ...args);
  }
  beginPath(): void {
    this.rec("beginPath");
  }
  moveTo(x: number, y: number): void {
    this.rec("moveTo", x, y);
  }
  lineTo(x: number, y: number): void {
    this.rec("lineTo", x, y);
  }
  closePath(): void {
    this.rec("closePath");
  }
  arc(...args: number[]): void {
    this.rec("arc", ...args);
  }
  stroke(): void {
    this.rec("stroke", this.state.strokeStyle, this.state.lineWidth, this.state.globalAlpha);
  }
  fill(): void {
    this.rec("fill", this.state.fillStyle, this.state.globalAlpha);
  }
  fillRect(...args: number[]): void {
    this.rec("fillRect", ...args, this.state.fillStyle);
  }
  fillText(text: string, x: number, y: number): void {
    this.rec("fillText", text, x, y, this.state.fillStyle, this.state.font);
  }
  measureText(text: string): { width: number } {
    return { width: text.length * 6 };
  }
  setLineDash(segments: number[]): void {
    this.rec("setLineDash", segments);
  }
  drawImage(...args: unknown[]): void {
    this.rec("drawImage", ...args);
  }

  get strokeStyle(): unknown {
    return this.state.strokeStyle;
  }
  set strokeStyle(v: unknown) {
    this.state.strokeStyle = v;
  }
  get fillStyle(): unknown {
    return this.state.fillStyle;
  }
  set fillStyle(v: unknown) {
    this.state.fillStyle = v;
  }
  get lineWidth(): number {
    return this.state.lineWidth as number;
  }
  set lineWidth(v: number) {
    this.state.lineWidth = v;
  }
  get globalAlpha(): number {
    return this.state.globalAlpha as number;
  }
  set globalAlpha(v: number) {
    this.state.globalAlpha = v;
  }
  get font(): string {
    return this.state.font as string;
  }
  set font(v: string) {
    this.state.font = v;
  }
  get textBaseline(): string {
    return this.state.textBaseline as string;
  }
  set textBaseline(v: string) {
    this.state.textBaseline = v;
  }
  get lineJoin(): string {
    return this.state.lineJoin as string;
  }
  set lineJoin(v: string) {
    this.state.lineJoin = v;
  }
  get lineCap(): string {
    return this.state.lineCap as string;
  }
  set lineCap(v: string) {
    this.state.lineCap = v;
  }
}
