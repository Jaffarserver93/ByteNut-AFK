import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import botRouter from "./bot.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(botRouter);

export default router;
