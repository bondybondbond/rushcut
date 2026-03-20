/**
 * lib/lambda.ts — Server-only AWS Lambda invoke helper.
 *
 * Never import this on the client side — it uses AWS credentials from env vars.
 *
 * InvocationType "Event" = async fire-and-forget. AWS returns 202 immediately.
 * "Invoke succeeded" ≠ "render started" — Lambda queues the event internally.
 */

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const client = new LambdaClient({ region: process.env.AWS_REGION! });

export async function invokeLambdaAsync(jobId: string): Promise<void> {
  const payload = Buffer.from(JSON.stringify({ job_id: jobId }));
  await client.send(
    new InvokeCommand({
      FunctionName: process.env.LAMBDA_FUNCTION_NAME!,
      InvocationType: "Event",
      Payload: payload,
    }),
  );
}
