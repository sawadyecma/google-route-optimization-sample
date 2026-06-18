import dotenv from 'dotenv';
import { GoogleAuth } from 'google-auth-library';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

dotenv.config();

const PROJECT_ID = process.env.GOOGLE_PROJECT_ID;

async function getAuthToken(): Promise<string> {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();
  if (!accessToken || !accessToken.token) {
    throw new Error('アクセストークンの取得に失敗しました');
  }
  return accessToken.token;
}

async function testGoogleRouteOptimization() {
  if (!PROJECT_ID) {
    console.error('環境変数 GOOGLE_PROJECT_ID が必要です');
    process.exit(1);
  }

  try {
    console.log('Google Route Optimization API をテスト中...');
    console.log(`Project ID: ${PROJECT_ID}`);

    const token = await getAuthToken();
    const url = `https://routeoptimization.googleapis.com/v1/projects/${PROJECT_ID}/:optimizeTours`;

    const request = {
      timeout: '2s',
      // ルート全体の道路に沿ったポリラインを routes[].routePolyline.points に格納させる
      populatePolylines: true,
      // 区間ごとのポリラインを routes[].transitions[].routePolyline.points に格納させる
      populateTransitionPolylines: true,
      model: {
        shipments: [
          {
            pickups: [
              {
                arrivalWaypoint: {
                  location: {
                    latLng: {
                      latitude: 37.802395,
                      longitude: -122.405822,
                    },
                  },
                },
                timeWindows: [
                  {
                    startTime: '2024-02-13T07:30:00Z',
                    endTime: '2024-02-13T09:30:00Z',
                  },
                ],
              },
            ],
            deliveries: [
              {
                arrivalWaypoint: {
                  location: {
                    latLng: {
                      latitude: 37.760202,
                      longitude: -122.426796,
                    },
                  },
                },
                timeWindows: [
                  {
                    startTime: '2024-02-13T09:30:00Z',
                    endTime: '2024-02-13T11:30:00Z',
                  },
                ],
              },
            ],
            label: 'Bernese mountain dog',
          },
          {
            pickups: [
              {
                arrivalWaypoint: {
                  location: {
                    latLng: {
                      latitude: 37.738067,
                      longitude: -122.498593,
                    },
                  },
                },
                timeWindows: [
                  {
                    startTime: '2024-02-13T07:30:00Z',
                    endTime: '2024-02-13T09:30:00Z',
                  },
                ],
              },
            ],
            deliveries: [
              {
                arrivalWaypoint: {
                  location: {
                    latLng: {
                      latitude: 37.760202,
                      longitude: -122.426796,
                    },
                  },
                },
                timeWindows: [
                  {
                    startTime: '2024-02-13T09:30:00Z',
                    endTime: '2024-02-13T11:30:00Z',
                  },
                ],
              },
            ],
            label: 'Chihuahua',
          },
        ],
        vehicles: [
          {
            startWaypoint: {
              location: {
                latLng: {
                  latitude: 37.760202,
                  longitude: -122.426796,
                },
              },
            },
            endWaypoint: {
              location: {
                latLng: {
                  latitude: 37.760202,
                  longitude: -122.426796,
                },
              },
            },
            costPerHour: 27,
            startTimeWindows: [
              {
                startTime: '2024-02-13T07:00:00Z',
                endTime: '2024-02-13T07:15:00Z',
              },
            ],
            endTimeWindows: [
              {
                startTime: '2024-02-13T11:45:00Z',
                endTime: '2024-02-13T12:00:00Z',
              },
            ],
          },
        ],
        globalStartTime: '2024-02-13T07:00:00Z',
        globalEndTime: '2024-02-13T19:00:00Z',
      },
    };

    const response = await axios.post(url, request, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });

    console.log('成功:', response.data);

    const tmpDir = path.resolve(__dirname, '..', 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(tmpDir, `response-${timestamp}.json`);
    fs.writeFileSync(outPath, JSON.stringify(response.data, null, 2));
    console.log(`レスポンスを保存しました: ${outPath}`);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('API エラー:', error.response?.status, error.response?.data);
    } else {
      console.error('エラー:', error);
    }
    process.exit(1);
  }
}

testGoogleRouteOptimization();
