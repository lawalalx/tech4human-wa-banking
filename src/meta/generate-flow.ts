import { buildAccountVerificationFlowJson } from "./meta-flow-builder";

const myFlowJson = buildAccountVerificationFlowJson({
  name: "Link Bank Account",
  description: "Securely link your account to enable rapid transfers.",
  banks: [
    { id: "058", title: "Guaranty Trust Bank (GTB)" },
    { id: "044", title: "Access Bank" },
    { id: "057", title: "Zenith Bank" },
    { id: "033", title: "United Bank for Africa (UBA)" },
    { id: "011", title: "First Bank" } // Matches your mock API example
  ],
  thankYouText: "Your bank account is now securely linked and ready for transactions."
});

console.log(JSON.stringify(myFlowJson, null, 2));
