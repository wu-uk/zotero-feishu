export interface DeviceRequestOptions {
  headers?: Record<string, string>;
  body?: string;
}

export interface DeviceHttpResult {
  status: number;
  data: any;
}

export interface DeviceProtocolDependencies {
  request(
    method: string,
    url: string,
    options?: DeviceRequestOptions,
  ): Promise<DeviceHttpResult>;
  delay(milliseconds: number): Promise<void>;
  now(): number;
}

export class AuthorizationCancelledError extends Error {}

export class InvalidFeishuApplicationError extends Error {}

export class FeishuDeviceProtocol {
  constructor(private readonly dependencies: DeviceProtocolDependencies) {}

  formRequest(
    url: string,
    body: Record<string, string>,
    headers: Record<string, string> = {},
  ): Promise<DeviceHttpResult> {
    return this.dependencies.request("POST", url, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: formEncode(body),
    });
  }

  async poll(
    options: {
      url: string;
      body: Record<string, string>;
      interval: number;
      expiresIn: number;
    },
    signal?: AbortSignal,
  ): Promise<any> {
    const deadline = this.dependencies.now() + options.expiresIn * 1000;
    let interval = Math.max(1, options.interval);
    while (this.dependencies.now() < deadline) {
      await this.wait(interval * 1000, signal);
      let response: DeviceHttpResult;
      try {
        response = await this.formRequest(options.url, options.body);
      } catch (error) {
        if (this.dependencies.now() >= deadline) throw error;
        interval = Math.min(60, interval + 1);
        continue;
      }
      const error = response.data?.error;
      if (!error && response.status >= 200 && response.status < 300) {
        return response.data;
      }
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        interval = Math.min(60, interval + 5);
        continue;
      }
      if (error === "access_denied") {
        throw new Error("Feishu authorization was denied");
      }
      if (error === "expired_token" || error === "invalid_grant") {
        throw new Error("Feishu authorization expired; try again");
      }
      if (isInvalidApplication(response.data)) {
        throw new InvalidFeishuApplicationError(responseMessage(response.data));
      }
      assertProtocolSuccess(response, "Feishu authorization failed");
    }
    throw new Error("Feishu authorization timed out; try again");
  }

  private async wait(milliseconds: number, signal?: AbortSignal) {
    assertActive(signal);
    await this.dependencies.delay(milliseconds);
    assertActive(signal);
  }
}

export function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AuthorizationCancelledError();
}

function assertProtocolSuccess(
  response: DeviceHttpResult,
  fallback: string,
): void {
  const data = response.data || {};
  if (
    response.status >= 200 &&
    response.status < 300 &&
    !data.error &&
    (!data.code || data.code === 0)
  ) {
    return;
  }
  throw new Error(data.error_description || data.msg || data.error || fallback);
}

function isInvalidApplication(data: any): boolean {
  return /invalid_client|specified app(?:lication)? is not enabled|app(?:lication)?[^\n]*(not found|deleted|disabled)/i.test(
    JSON.stringify(data || {}),
  );
}

function responseMessage(data: any): string {
  return (
    data?.error_description ||
    data?.msg ||
    data?.error ||
    "The configured Feishu app is unavailable"
  );
}

function formEncode(body: Record<string, string>): string {
  return Object.entries(body)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
}
