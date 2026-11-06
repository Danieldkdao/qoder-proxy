import { Router } from "express";
import { handleChat } from "./chat";
export const completionsRouter = Router();
completionsRouter.post("/", (req, res) => {
  void handleChat(req, res, true);
});
