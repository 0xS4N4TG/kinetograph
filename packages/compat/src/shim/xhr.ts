// `XMLHttpRequest` as a thin layer over the shim's `fetch`, so it reads what `fetch` reads (project files, `data:` and
// `blob:` URLs, the downloaded remote files) and refuses what `fetch` refuses, with the same message in the `error`
// event's `message`. Asynchronous only: a synchronous request would have to block this thread.

type Handler = ((event: Event) => void) | null;
const EVENTS = ['readystatechange', 'loadstart', 'progress', 'load', 'error', 'abort', 'timeout', 'loadend'] as const;

export class XMLHttpRequestShim extends EventTarget {
  static readonly UNSENT = 0;
  static readonly OPENED = 1;
  static readonly HEADERS_RECEIVED = 2;
  static readonly LOADING = 3;
  static readonly DONE = 4;

  onreadystatechange: Handler = null;
  onloadstart: Handler = null;
  onprogress: Handler = null;
  onload: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  ontimeout: Handler = null;
  onloadend: Handler = null;
  responseType: XMLHttpRequestResponseType = '';
  timeout = 0;
  withCredentials = false;
  readyState = 0;
  status = 0;
  statusText = '';
  response: unknown = null;
  responseURL = '';
  private method = 'GET';
  private url = '';
  private readonly headers: Record<string, string> = {};
  private reply: Response | null = null;
  private aborted = false;

  get responseText(): string {
    if (this.responseType !== '' && this.responseType !== 'text') throw new DOMException(`Failed to read the 'responseText' property: the value is only accessible if the object's 'responseType' is '' or 'text' (was '${this.responseType}').`, 'InvalidStateError');
    return typeof this.response === 'string' ? this.response : '';
  }

  open(method: string, url: string | URL, async = true): void {
    if (!async) throw new DOMException('Synchronous XMLHttpRequest is not available: it would block the thread that renders the frame. Use an asynchronous request.', 'InvalidAccessError');
    this.method = method.toUpperCase();
    this.url = String(url);
    this.aborted = false;
    this.reply = null;
    this.setState(1);
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  overrideMimeType(): void {}
  getResponseHeader(name: string): string | null {
    return this.reply?.headers.get(name) ?? null;
  }
  getAllResponseHeaders(): string {
    let out = '';
    this.reply?.headers.forEach((value, key) => (out += `${key}: ${value}\r\n`));
    return out;
  }
  abort(): void {
    if (this.readyState === 0 || this.readyState === 4) return;
    this.aborted = true;
    this.status = 0;
    this.setState(4);
    this.fire('abort');
    this.fire('loadend');
  }

  send(body?: BodyInit | null): void {
    if (this.readyState !== 1) throw new DOMException("Failed to execute 'send' on 'XMLHttpRequest': the object's state must be OPENED.", 'InvalidStateError');
    this.fire('loadstart');
    void (async () => {
      try {
        const reply = await fetch(this.url, { method: this.method, headers: this.headers, ...(body !== undefined && body !== null ? { body } : {}) });
        if (this.aborted) return;
        this.reply = reply;
        this.status = reply.status;
        this.statusText = reply.statusText;
        this.responseURL = this.url;
        this.setState(2);
        this.response = await this.read(reply);
        if (this.aborted) return;
        this.setState(3);
        this.fire('progress');
        this.setState(4);
        this.fire('load');
      } catch (error) {
        if (this.aborted) return;
        this.status = 0;
        this.setState(4);
        const failure = new Event('error');
        Object.defineProperty(failure, 'message', { value: error instanceof Error ? error.message : String(error) });
        this.dispatch(failure);
      }
      if (!this.aborted) this.fire('loadend');
    })();
  }

  private async read(reply: Response): Promise<unknown> {
    switch (this.responseType) {
      case 'arraybuffer': return reply.arrayBuffer();
      case 'blob': return reply.blob();
      case 'json': {
        try {
          return JSON.parse(await reply.text());
        } catch {
          return null;
        }
      }
      default: return reply.text();
    }
  }
  private setState(state: number): void {
    this.readyState = state;
    this.fire('readystatechange');
  }
  private fire(type: (typeof EVENTS)[number]): void {
    this.dispatch(new Event(type));
  }
  private dispatch(event: Event): void {
    const handler = (this as unknown as Record<string, Handler>)[`on${event.type}`];
    try {
      handler?.call(this, event);
    } catch (error) {
      console.error(`Uncaught ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    }
    this.dispatchEvent(event);
  }
}
