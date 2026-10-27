// Keeping redraws in check (Chris, 10-27-2026 — "Page unresponsive" on the test site). No browser or database code
// here, so it's tested on its own (functions/test/batch.test.js).

// One call for a burst. Many live listeners answer at once — at start-up, and when the tab wakes up and reconnects —
// and each used to redraw the whole screen: 70+ full Home redraws in a row. batch(fn) returns a function that,
// however often it's called, runs fn once, waitMs later.
export function batch(fn, waitMs = 30) {
  let timer = null;
  const run = () => { timer = null; fn(); };
  const call = () => { if (!timer) timer = setTimeout(run, waitMs); };
  call.cancel = () => { clearTimeout(timer); timer = null; };
  return call;
}

// Something Home asks the server for now and then (who's on shift, my station, tasks to confirm). Home calls the
// returned check(onRedraw) on every redraw. load() runs only when isFresh() says it's time, and the redraw is kept only
// while a load is running — the latest one, run once when it ends. (Each redraw used to be kept even between loads and
// all of them ran after the next load, each adding more: the pile doubled every 2 minutes until Chrome froze.)
export function serverCheck(load, isFresh) {
  let loading = false;
  let redraw = null;
  return (onRedraw) => {
    if (!loading && isFresh()) return;
    if (onRedraw) redraw = onRedraw;
    if (loading) return;
    loading = true;
    Promise.resolve().then(load).catch(() => {}).finally(() => {
      loading = false;
      const f = redraw;
      redraw = null;
      f?.();
    });
  };
}
