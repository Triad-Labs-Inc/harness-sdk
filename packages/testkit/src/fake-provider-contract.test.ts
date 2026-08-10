import type { ProviderAdapterV1 } from "@triadlabs/harness";

import { fakeProvider, FakeProviderController } from "./fake-provider.js";
import { providerContract, type ProviderContractScenario } from "./provider-contract.js";

function adapterFor(scenario: ProviderContractScenario): ProviderAdapterV1 {
  const controller = new FakeProviderController();
  switch (scenario) {
    case "stream":
      controller.enqueue(
        controller.script({ type: "text", chunks: ["one", "two"] }, { type: "complete" }),
      );
      break;
    case "tools":
      controller.enqueue(
        controller.script(
          { type: "tool", id: "fixture-tool", name: "fixture", input: {}, output: "done" },
          { type: "complete" },
        ),
      );
      break;
    case "permission_allow_once":
    case "permission_allow_session":
    case "permission_deny":
    case "permission_cancel":
      controller.enqueue(
        controller.script(
          { type: "permission", id: "permission", title: "Allow fixture?" },
          { type: "complete" },
        ),
      );
      break;
    case "questions":
      controller.enqueue(
        controller.script(
          {
            type: "input",
            id: "questions",
            questions: [
              {
                id: "q-single",
                prompt: "Single?",
                options: [{ value: "yes", label: "Yes" }],
              },
              { id: "q-multi", prompt: "Multiple?", multiple: true },
              { id: "q-free", prompt: "Free?", allowFreeText: true },
            ],
          },
          { type: "complete" },
        ),
      );
      break;
    case "interrupt":
      controller.enqueue(controller.script({ type: "delay", ms: 10_000 }, { type: "complete" }));
      break;
    case "crash":
      controller.enqueue(controller.script({ type: "crash", message: "fixture crash" }));
      break;
    case "failed":
      controller.enqueue(
        controller.script({
          type: "fail",
          code: "FAKE_REPORTED_FAILURE",
          message: "fixture failure",
          mayHaveSideEffects: true,
        }),
      );
      break;
    case "unknown":
      controller.enqueue(
        controller.script(
          { type: "diagnostic", message: "unknown fixture", level: "warning" },
          { type: "complete" },
        ),
      );
      break;
    case "resume":
      controller.enqueue(
        controller.script({ type: "complete" }),
        controller.script({ type: "complete" }),
      );
      break;
  }
  return fakeProvider(controller);
}

providerContract("fake", adapterFor);
