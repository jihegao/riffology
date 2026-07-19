export type WorkbenchIntent =
  | { type: "open_tab"; tab: "files" | "parameters" | "run" | "results" }
  | { type: "set_parameter"; key: string; value: string | number | boolean }
  | { type: "start_run" }
  | { type: "open_results"; runId: string };

export type ProjectionResult = { status: "verified" | "failed"; reason?: string };

export interface WorkbenchProjector {
  project(intent: WorkbenchIntent): Promise<ProjectionResult>;
}

/**
 * Optional local-only CDP projection. Domain state is committed before this
 * wrapper is called; a missing Playwright installation or locator never changes
 * Mesa/project state.
 */
export class PlaywrightCdpProjector implements WorkbenchProjector {
  private readonly cdpUrl?: string;

  constructor(cdpUrl?: string) {
    this.cdpUrl = cdpUrl;
  }

  async project(intent: WorkbenchIntent): Promise<ProjectionResult> {
    if (!this.cdpUrl) return { status: "failed", reason: "Browser projection is not configured." };
    try {
      const playwright = await import("playwright").catch(() => undefined as any);
      if (!playwright?.chromium) return { status: "failed", reason: "Playwright is not installed for browser projection." };
      const browser = await playwright.chromium.connectOverCDP(this.cdpUrl);
      try {
        const page = browser.contexts().flatMap((context: any) => context.pages()).find((candidate: any) => candidate.url().startsWith("http://127.0.0.1") || candidate.url().startsWith("http://localhost"));
        if (!page) return { status: "failed", reason: "No visible local workbench page is attached over CDP." };
        await enact(page, intent);
        return { status: "verified" };
      } finally {
        await browser.close();
      }
    } catch {
      return { status: "failed", reason: "The visible workbench could not be projected." };
    }
  }
}

const enact = async (page: any, intent: WorkbenchIntent): Promise<void> => {
  switch (intent.type) {
    case "open_tab":
      await page.getByTestId(`workbench-tab-${intent.tab}`).click();
      return;
    case "set_parameter":
      await page.getByTestId(`parameter-input-${intent.key}`).fill(String(intent.value));
      return;
    case "start_run":
      // The run already exists in Mesa before projection. Never issue a second
      // browser click that could become an alternative domain authority.
      await page.getByRole("status", { name: "Simulation status" }).waitFor();
      return;
    case "open_results":
      await page.getByTestId(`results-run-${intent.runId}`).scrollIntoViewIfNeeded();
      return;
  }
};

export class NoopProjector implements WorkbenchProjector {
  async project(): Promise<ProjectionResult> {
    return { status: "failed", reason: "Browser projection is disabled." };
  }
}
