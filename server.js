const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();

app.use(express.json());
app.use(cors());

// ✅ Production Credentials
const MERCHANT_KEY = "b3ac0315-843a-4560-9e49-118b67de175c";
const MERCHANT_ID = "M22PU06UWBZNO";
const MERCHANT_BASE_URL = "https://api.phonepe.com/apis/hermes/pg/v1/pay";
const MERCHANT_STATUS_URL = "https://api.phonepe.com/apis/hermes/pg/v1/status";

const redirectUrl = "https://uwcindia.in/status";
const successUrl = "https://uwcindia.in/payment-success";
const failureUrl = "https://uwcindia.in/payment-failure";

app.post("/create-order", async (req, res) => {
  try {
    const { name, mobileNumber, amount } = req.body;
    if (!name || !mobileNumber || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const orderId = uuidv4();

    const paymentPayload = {
      merchantId: MERCHANT_ID,
      merchantUserId: name,
      mobileNumber: mobileNumber,
      amount: amount * 100, // Convert amount to paisa
      merchantTransactionId: orderId,
      redirectUrl: `${redirectUrl}/${orderId}`,
      redirectMode: "POST",
      paymentInstrument: {
        type: "PAY_PAGE",
      },
    };

    const payload = Buffer.from(JSON.stringify(paymentPayload)).toString(
      "base64"
    );
    const keyIndex = 1;
    const string = payload + "/pg/v1/pay" + MERCHANT_KEY;
    const sha256 = crypto.createHash("sha256").update(string).digest("hex");
    const checksum = sha256 + "###" + keyIndex;

    const options = {
      method: "POST",
      url: MERCHANT_BASE_URL,
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "X-VERIFY": checksum,
      },
      data: {
        request: payload,
      },
    };

    const response = await axios.request(options);

    if (response.data.success && response.data.data.instrumentResponse) {
      console.log(
        "✅ Payment URL:",
        response.data.data.instrumentResponse.redirectInfo.url
      );
      return res.status(200).json({
        msg: "OK",
        url: response.data.data.instrumentResponse.redirectInfo.url,
      });
    } else {
      console.error("❌ Payment initiation failed", response.data);
      return res.status(500).json({ error: "Failed to initiate payment" });
    }
  } catch (error) {
    console.error(
      "❌ Error in payment:",
      error.response?.data || error.message
    );
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/status/:id", async (req, res) => {
  try {
    const merchantTransactionId = req.params.id;
    if (!merchantTransactionId) {
      return res.status(400).json({ error: "Transaction ID is required" });
    }

    const keyIndex = 1;
    const string =
      `/pg/v1/status/${MERCHANT_ID}/${merchantTransactionId}` + MERCHANT_KEY;
    const sha256 = crypto.createHash("sha256").update(string).digest("hex");
    const checksum = sha256 + "###" + keyIndex;

    const options = {
      method: "GET",
      url: `${MERCHANT_STATUS_URL}/${MERCHANT_ID}/${merchantTransactionId}`,
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "X-VERIFY": checksum,
      },
    };

    const response = await axios.request(options);

    if (response.data.success) {
      return res.redirect(successUrl);
    } else {
      return res.redirect(failureUrl);
    }
  } catch (error) {
    console.error(
      "❌ Error checking payment status:",
      error.response?.data || error.message
    );
    res.status(500).json({ error: "Failed to check payment status" });
  }
});

app.listen(8000, () => {
  console.log("✅ Server is running on port 8000");
});
