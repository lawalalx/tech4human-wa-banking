/**
 * WhatsApp Flow JSON Builder for Account Verification
 * 
 * Architecture:
 * - ONE main screen (ACCOUNT_FORM).
 * - The OTP field starts hidden (`show_otp: false`).
 * - The Submit button starts disabled (`enabled: "${data.show_otp}"`).
 * - The Bank Dropdown acts as the trigger. Its `on-select-action` fires a `data_exchange`
 *   with `action_type: "verify_account"`.
 * - The Webhook validates the account, returns `show_otp: true`, which pops the OTP field
 *   into view and enables the Submit footer.
 * - Clicking the Footer fires `data_exchange` with `action_type: "submit_form"`.
 */

export interface BankOption {
  id: string;
  title: string;
}

export interface VerificationFlowParams {
  name: string;
  description?: string;
  banks: BankOption[];
  thankYouText?: string;
}

// --- Helpers ------------------------------------------------------------------

function truncate(str: string, max: number): string {
  return str.length > max ? str.substring(0, max - 1) + '...' : str;
}

export function sanitizeOptionId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

// --- Main Builder -------------------------------------------------------------

export function buildAccountVerificationFlowJson(params: VerificationFlowParams): any {
  const { name, description, banks, thankYouText } = params;

  return {
    version: '7.0',
    data_api_version: '3.0',
    routing_model: {
      INTRO: ['ACCOUNT_FORM'],
      ACCOUNT_FORM: ['COMPLETE'],
      COMPLETE: []
    },
    screens: [
      buildIntroScreen(name, description, 'ACCOUNT_FORM'),
      buildFormScreen(name, banks),
      buildCompleteScreen(thankYouText)
    ]
  };
}

// --- Screen Builders ----------------------------------------------------------

function buildIntroScreen(name: string, description: string | undefined, nextScreen: string): any {
  return {
    id: 'INTRO',
    title: truncate(name, 20),
    layout: {
      type: 'SingleColumnLayout',
      children: [
        { type: 'TextHeading', text: truncate(name, 80) },
        { 
          type: 'TextBody', 
          text: description || 'Please provide your details to verify your bank account securely.' 
        },
        {
          type: 'Footer',
          label: 'Start Verification',
          'on-click-action': {
            name: 'navigate',
            next: { type: 'screen', name: nextScreen },
            payload: {}
          }
        }
      ]
    }
  };
}

function buildFormScreen(name: string, banks: BankOption[]): any {
  // 1. Define the dynamic state variables that the webhook will control
  const screenData = {
    show_otp: { type: 'boolean', '__example__': false },
    show_account_error: { type: 'boolean', '__example__': false },
    account_error: { type: 'string', '__example__': '' },
    otpReference: { type: 'string', '__example__': '' }
  };

  return {
    id: 'ACCOUNT_FORM',
    title: truncate(name, 20),
    data: screenData,
    layout: {
      type: 'SingleColumnLayout',
      children: [
        // Error Message Banner (Only visible if webhook returns show_account_error: true)
        {
          type: 'TextBody',
          text: '${data.account_error}',
          visible: '${data.show_account_error}',
        },
        
        // Standard User Information
        {
          type: 'TextInput',
          name: 'firstname',
          label: 'First Name',
          'input-type': 'text',
          required: true
        },
        {
          type: 'TextInput',
          name: 'lastname',
          label: 'Last Name',
          'input-type': 'text',
          required: true
        },
        {
          type: 'TextInput',
          name: 'account',
          label: 'Account Number',
          'input-type': 'number',
          'helper-text': 'Enter your 10-digit account number before selecting a bank',
          required: true
        },

        // Bank Selector (The Trigger Component)
        {
          type: 'Dropdown',
          name: 'bank',
          label: 'Select Bank',
          required: true,
          'data-source': banks.map(b => ({
            id: sanitizeOptionId(b.id),
            title: truncate(b.title, 30)
          })),
          // When a bank is selected, ping the webhook to validate the account number
          'on-select-action': {
            name: 'data_exchange',
            payload: {
              action_type: 'verify_account',
              firstname: '${form.firstname}',
              lastname: '${form.lastname}',
              account: '${form.account}',
              bank: '${form.bank}'
            }
          }
        },

        // OTP Field (Hidden until webhook confirms account and sets show_otp: true)
        {
          type: 'TextInput',
          name: 'otp',
          label: 'Enter 6-Digit OTP',
          'input-type': 'number',
          'helper-text': 'A code has been sent to your registered email/phone.',
          required: true,
          visible: '${data.show_otp}'
        },

        // Main Submit Button
        {
          type: 'Footer',
          label: 'Submit Verification',
          enabled: '${data.show_otp}',
          'on-click-action': {
            name: 'data_exchange',
            payload: {
              action_type: 'submit_form',
              firstname: '${form.firstname}',
              lastname: '${form.lastname}',
              account: '${form.account}',
              bank: '${form.bank}',
              otp: '${form.otp}',
              // 2. Send the state back to the webhook on submit
              otpReference: '${data.otpReference}' 
            }
          }
        }
      ]
    }
  };
}

function buildCompleteScreen(thankYouText: string | undefined): any {
  return {
    id: 'COMPLETE',
    title: 'Verification Complete',
    terminal: true,
    layout: {
      type: 'SingleColumnLayout',
      children: [
        { type: 'TextHeading', text: 'Account Verified!' },
        { 
          type: 'TextBody', 
          text: thankYouText || 'Your bank account has been successfully verified and linked to your profile.' 
        },
        {
          type: 'Footer',
          label: 'Close Window',
          'on-click-action': { name: 'complete', payload: {} }
        }
      ]
    }
  };
}




export function buildSetTransactionPinFlowJson() {
  return {
    version: "7.0",
    data_api_version: "3.0",
    routing_model: {
      PIN_SETUP_SCREEN: ["COMPLETE"],
      COMPLETE: []
    },
    screens: [
      {
        id: "PIN_SETUP_SCREEN",
        title: "Set Transaction PIN",
        data: {
          show_error: { type: "boolean", __example__: false },
          error_message: { type: "string", __example__: "" }
        },
        layout: {
          type: "SingleColumnLayout",
          children: [
            {
              type: "TextHeading",
              text: "Create your 4-digit PIN"
            },
            {
              type: "TextBody",
              text: "This PIN will be used to authorize all your transfers and bill payments. Never share it."
            },
            {
              type: "TextInput",
              name: "pin",
              label: "Enter 4-digit PIN",
              "input-type": "password",
              required: true,
              "max-chars": 4
            },
            {
              type: "TextInput",
              name: "confirm_pin",
              label: "Confirm 4-digit PIN",
              "input-type": "password",
              required: true,
              "max-chars": 4
            },
            {
              type: "TextBody",
              text: "${data.error_message}",
              visible: "${data.show_error}"
            },
            {
              type: "Footer",
              label: "Save PIN",
              "on-click-action": {
                name: "data_exchange",
                payload: {
                  action_type: "submit_pin",
                  pin: "${form.pin}",
                  confirm_pin: "${form.confirm_pin}"
                }
              }
            }
          ]
        }
      },
      {
        id: "COMPLETE",
        title: "PIN Set Successfully",
        terminal: true,
        data: {},
        layout: {
          type: "SingleColumnLayout",
          children: [
            {
              type: "TextHeading",
              text: "✅ PIN Created!"
            },
            {
              type: "TextBody",
              text: "Your transaction PIN has been set successfully. You can now close this screen to return to WhatsApp."
            },
            {
              type: "Footer",
              label: "Close Window",
              "on-click-action": {
                name: "complete",
                payload: {}
              }
            }
          ]
        }
      }
    ]
  };
}
