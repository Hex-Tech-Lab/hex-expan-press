/** Natural sort for review codes: A, A1, B1 … B10, Q1, Q2, Q10 … (legacy parity). */
export function naturalCode(a: string, b: string): number {
  const x = a.split(/(\d+)/);
  const y = b.split(/(\d+)/);
  for (let k = 0; k < Math.min(x.length, y.length); k++) {
    const isNumX = /^\d+$/.test(x[k]);
    const isNumY = /^\d+$/.test(y[k]);
    if (isNumX && isNumY) {
      const diff = Number(x[k]) - Number(y[k]);
      if (diff !== 0) return diff;
    } else if (x[k] !== y[k]) {
      return x[k].localeCompare(y[k]);
    }
  }
  return x.length - y.length;
}
