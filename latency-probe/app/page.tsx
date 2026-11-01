// Static shell. Numbers come from /api/dashboard-data, fetched by /dashboard.js.
export default function Page() {
  return (
    <div className="page-root">
      <p id="announce" className="sr-only" aria-live="polite"></p>
      <header id="topbar" className="topbar">
          <div className="bar">
            <h1 className="bar-title">ExpanPress speed</h1>
            <span id="pill" className="pill old" title="Shows whether this page can reach its data. It does not say whether the site itself is healthy.">
              <span className="dot" aria-hidden="true"></span>
              <span id="pill-text" className="long">Loading</span><span id="pill-short" className="short">Loading</span>
            </span>
            <span id="countdown" className="bar-count muted"><span className="long">Refresh in </span><span id="cd-time">5:00</span></span>
            <button id="refresh" className="btn icon" type="button" aria-label="Refresh now" title="Refresh now">
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <button id="controls-btn" className="btn" type="button" aria-expanded="false" aria-controls="controls-panel">Controls</button>
          </div>
      </header>
        <div id="controls-panel" className="panel" hidden>
          <p className="desc">How quickly expanpress.com responds and loads, checked every 30 minutes from US locations. Real-browser tests are added as they arrive.</p>
          <div className="panel-row">
            <div className="seg" role="group" aria-label="What to measure">
              <button id="m-ttfb" className="btn" type="button" aria-pressed="false">First byte</button>
              <button id="m-total" className="btn" type="button" aria-pressed="true">Full load</button>
            </div>
            <div className="seg" role="group" aria-label="Time range">
              <button id="r-24h" className="btn" type="button" aria-pressed="true">24 hours</button>
              <button id="r-7d" className="btn" type="button" aria-pressed="false">7 days</button>
            </div>
            <label className="auto">
              <input id="auto" type="checkbox" defaultChecked />
              <span>Refresh automatically every 5 minutes</span>
            </label>
          </div>
          <p id="data-since" className="muted small" style={{ margin: "6px 0 0" }}></p>
          <p className="muted small panel-foot">Last updated <span id="updated">not yet</span></p>
        </div>

      <p id="status" className="status" role="status">Loading the latest data.</p>
      <div id="error-box" className="errorbox" hidden>
        <span>Could not load the data.</span>
        <button id="retry" className="btn primary" type="button">Retry</button>
      </div>

      <h2>Latest results</h2>
      <div id="cards" className="cards"></div>

      <section className="card" aria-labelledby="chart-h">
        <h2 id="chart-h" style={{ marginTop: 0 }}>Speed over time</h2>
        <p className="muted chart-caption">Times: Cairo</p>
        <div id="legend" className="legend" role="group" aria-label="Lines. Select a line to show or hide it."></div>
        <p id="axis-title" className="axis-title"></p>
        <div id="chart-wrap" className="chart-wrap">
          <div id="chart" className="chart"></div>
        <p id="chart-summary" className="sr-only"></p>
        </div>
        <p id="chart-note" className="muted note"></p>
      </section>

      <section className="card" aria-labelledby="ep-h">
        <h2 id="ep-h" style={{ marginTop: 0 }}>Each endpoint, separately</h2>
        <p className="muted chart-caption">Every 30 minutes all seven endpoints are measured. Each card is one endpoint. Use its buttons to choose First byte, Full load or both. Drag a card by its handle, or focus the handle and use the arrow keys, to place it. Red dots are failed checks. Times: Cairo. Your arrangement and choices stay on this device.</p>
        <div className="ep-toolbar">
          <button id="ep-shared" className="btn" type="button" aria-pressed="false" title="Off: each card fits its own readings. On: every card uses one scale, so they can be compared.">Same scale on all cards</button>
          <button id="ep-reset" className="btn" type="button">Reset layout</button>
        </div>
        <div id="per-endpoint" className="ep-grid"></div>
        <p id="ep-empty" className="muted" hidden>No per-endpoint data in this range yet.</p>
      </section>

      <h2>Latest check</h2>
      <p id="latest-note" className="muted" style={{ margin: "0 0 6px" }}></p>
      <div className="wrap">
        <table>
          <thead>
            <tr><th scope="col">Location</th><th scope="col">Full load</th><th scope="col">First byte</th><th scope="col">Worked</th><th scope="col">Timed out</th></tr>
          </thead>
          <tbody id="latest-body"></tbody>
        </table>
      </div>




      <details className="acc">
        <summary>What the numbers mean</summary>
        <dl className="defs">
          <dt>Status</dt><dd>&quot;Live, updated N min ago&quot;: the page loaded its data within the last 10 minutes. &quot;Data N min old&quot;: the last successful load was more than 10 minutes ago. &quot;Can&apos;t reach the data&quot;: the last load failed. This is about this dashboard&apos;s connection to its data. It does not say whether the site is healthy.</dd>
          <dt>First byte</dt><dd>How long it takes from asking for a page until the first part of the reply arrives. Lower is faster.</dd>
          <dt>Full load</dt><dd>How long it takes until the whole page has arrived. Lower is faster.</dd>
          <dt>Largest content (LCP)</dt><dd>When the largest item on the page appears on screen. Measured in a real browser.</dd>
          <dt>Worked</dt><dd>The share of checks that got a proper reply without an error. For the Supabase and Upstash checks, a &quot;please log in&quot; reply counts as working, because that is the expected answer.</dd>
          <dt>Timed out</dt><dd>No reply for 6 seconds. Timed-out checks are left out of the typical values.</dd>
          <dt>Seven checks per run</dt><dd>Every 30 minutes the server measures seven endpoints, one after another. Each has its own line under &quot;Each endpoint, separately&quot;. The main chart shows the middle value across all seven, so it moves when the set of endpoints changes.</dd>
          <dt>Typical</dt><dd>The middle value of all checks. Half were faster and half were slower.</dd>
        </dl>
      </details>

      <noscript><p className="status bad">This dashboard needs JavaScript to draw the charts and load the data.</p></noscript>
      <script type="importmap" dangerouslySetInnerHTML={{ __html: '{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.min.js"}}' }} />
      <script type="module" src="/dashboard.js"></script>
    </div>
  );
}
