import { env } from "./config/env";

console.log("Environment loaded successfully:");
console.log({ NODE_ENV: env.NODE_ENV, PORT: env.PORT });