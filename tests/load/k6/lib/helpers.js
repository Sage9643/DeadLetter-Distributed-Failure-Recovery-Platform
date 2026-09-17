import http from "k6/http";
import { check } from "k6";
import { BASE_URL } from "./config.js";

export function submitJob(type, payload) {
  const res = http.post(
    `${BASE_URL}/api/jobs`,
    JSON.stringify({ type, payload }),
    { headers: { "Content-Type": "application/json" } }
  );
  check(res, {
    "submit status is 201": (r) => r.status === 201,
  });
  return res;
}