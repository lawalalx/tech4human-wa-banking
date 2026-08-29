import { FlowQuestion } from './flowBuilder';

export const linkAccountQuestions: FlowQuestion[] = [
  { id: 'firstName', text: 'First Name', type: 'text', required: true },
  { id: 'lastName', text: 'Last Name', type: 'text', required: true },
  { id: 'email', text: 'Email Address', type: 'text', required: true },
  { id: 'accountNumber', text: 'Account Number (10 digits)', type: 'text', required: true },
  
  // Note: To make this conditionally appear via your builder, it would normally 
  // rely on a 'showIf' tied to a previous field. If your builder doesn't support 
  // server-driven visibility toggles natively yet, you might leave it as a required 
  // field on a separate screen, OR utilize the data_exchange payload to transition states.
  { 
    id: 'otp', 
    text: 'Enter OTP Sent to your Phone', 
    type: 'text', 
    required: false // Made false initially so they can submit the first step
  }
];
