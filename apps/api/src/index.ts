import { env } from "./config/env";
import { app } from "./app";

app.listen(env.PORT, () => {
  console.log(`DeadLetter API listening on port ${env.PORT}`);
});