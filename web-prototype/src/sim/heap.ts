/** Binary min-heap of (id, priority) pairs; ties broken by id for determinism. */
export class MinHeap {
  private ids: number[] = [];
  private pr: number[] = [];

  get size() {
    return this.ids.length;
  }

  push(id: number, p: number) {
    this.ids.push(id);
    this.pr.push(p);
    let i = this.ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(i, parent)) {
        this.swap(i, parent);
        i = parent;
      } else break;
    }
  }

  pop(): [number, number] {
    const top: [number, number] = [this.ids[0], this.pr[0]];
    const lastId = this.ids.pop()!,
      lastP = this.pr.pop()!;
    if (this.ids.length) {
      this.ids[0] = lastId;
      this.pr[0] = lastP;
      let i = 0;
      const n = this.ids.length;
      for (;;) {
        const l = i * 2 + 1,
          r = l + 1;
        let m = i;
        if (l < n && this.less(l, m)) m = l;
        if (r < n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private less(a: number, b: number) {
    return this.pr[a] < this.pr[b] || (this.pr[a] === this.pr[b] && this.ids[a] < this.ids[b]);
  }

  private swap(a: number, b: number) {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.pr[a], this.pr[b]] = [this.pr[b], this.pr[a]];
  }
}
