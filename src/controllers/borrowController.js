import { borrowService } from "../services/borrowService.js";
import { sendSuccess } from "../utils/apiResponse.js";
export function createBorrowControllers(service = borrowService) {
  return {
    create: async (req, res) => sendSuccess(res, await service.borrow(req.validated.body, req.user), 201),
    list: async (req, res) => sendSuccess(res, await service.list(req.validated.query, req.user)),
    returnBook: async (req, res) => sendSuccess(res, await service.returnBook(req.validated.params.id, req.user)),
  };
}
