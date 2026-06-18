import axios, { AxiosError } from 'axios';
import { getAuthToken } from './google-auth';

export type OptimizeToursRequest = Record<string, unknown>;
export type OptimizeToursResponse = Record<string, unknown>;

export class RouteOptimizationError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'RouteOptimizationError';
  }
}

export async function optimizeTours(
  projectId: string,
  request: OptimizeToursRequest,
): Promise<OptimizeToursResponse> {
  const token = await getAuthToken();
  const url = `https://routeoptimization.googleapis.com/v1/projects/${projectId}/:optimizeTours`;

  try {
    const response = await axios.post<OptimizeToursResponse>(url, request, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      throw new RouteOptimizationError(
        axiosError.message,
        axiosError.response?.status ?? 500,
        axiosError.response?.data,
      );
    }
    throw error;
  }
}
