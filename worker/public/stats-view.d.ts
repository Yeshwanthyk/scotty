export interface StatsCounts {
  readonly workspacesCreated: number;
  readonly warmNow: number;
  readonly stoppedNow: number;
}

export interface StatsProject extends StatsCounts {
  readonly repository: string;
  readonly lastCreated: string;
}

export interface StatsResponse {
  readonly trackingSince: string | null;
  readonly overall: StatsCounts & { readonly projects: number };
  readonly projects: StatsProject[];
}

export function statsResponse(value: unknown): StatsResponse | undefined;
export function displayDate(value: unknown): string | undefined;
