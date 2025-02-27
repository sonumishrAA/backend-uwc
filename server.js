const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const app = express();

app.use(express.json());
app.use(
  cors({
    origin: "https://uwcindia.in", // Your production frontend domain
    methods: ["GET", "POST"]
  })
);

// Production Configuration
const MERCHANT_ID = process.env.MERCHANT_ID || "M22PU06UWBZNO";
const MERCHANT_KEY = process.env.MERCHANT_KEY || "b3ac0315-843a-4560-9e49-118b67de175c";
const KEY_INDEX = 1; // Production API Key Index

// Production Endpoints
const MERCHANT_BASE_URL = process.env.MERCHANT_BASE_URL || "https://api.phonepe.com/apis/hermes/pg/v1/pay";
const MERCHANT_STATUS_URL = process.env.MERCHANT_STATUS_URL || "https://api.phonepe.com/apis/hermes/pg/v1/status";

// Redirect URLs (adjust as needed)
const redirectUrl = process.env.REDIRECT_URL || "https://backend-uwc.onrender.com/payment-success";
const successUrl = process.env.SUCCESS_URL || "https://uwcindia.in/payment-success";
const failureUrl = process.env.FAILURE_URL || "https://uwcindia.in/payment-failed";

// Utility function to generate PhonePe checksum
const generateChecksum = (payload, endpoint) => {
  const string = payload + endpoint + MERCHANT_KEY;
  const sha256 = crypto.createHash("sha256").update(string).digest("hex");
  return sha256 + "###" + KEY_INDEX;
};

// API Endpoint to create an order and initiate payment
app.post("/create-order", async (req, res) => {
  try {
    const { name, mobileNumber, amount } = req.body;
    if (!name || !mobileNumber || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Generate a unique order ID (used as merchantTransactionId)
    const orderId = uuidv4();

    // Prepare PhonePe payload
    const paymentPayload = {
      merchantId: MERCHANT_ID,
      merchantUserId: name, // Alternatively, you could use orderId if needed
      mobileNumber,
      amount: Number(amount) * 100, // Convert rupees to paise
      currency: "INR",
      merchantTransactionId: orderId,
      redirectUrl: `${redirectUrl}?id=${orderId}`, // PhonePe will redirect here after payment
      redirectMode: "POST",
      paymentInstrument: { type: "PAY_PAGE" }
    };

    console.log("Payment Payload:", paymentPayload);

    // Encode the payload and generate checksum
    const payloadBase64 = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const checksum = generateChecksum(payloadBase64, "/pg/v1/pay");

    console.log("Base64 Payload:", payloadBase64);
    console.log("Checksum:", checksum);

    // Make API request to PhonePe
    const response = await axios.post(
      MERCHANT_BASE_URL,
      { request: payloadBase64 },
      {
        headers: {
          "accept": "application/json",
          "Content-Type": "application/json",
          "X-VERIFY": checksum
        }
      }
    );

    if (response.data.success) {
      return res.status(200).json({
        msg: "OK",
        url: response.data.data.instrumentResponse.redirectInfo.url
      });
    } else {
      throw new Error(response.data.message || "Failed to initiate payment");
    }
  } catch (error) {
    console.error("Error in payment initiation:", error.message);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

// Payment Status Route
app.get("/payment-success", async (req, res) => {
  try {
    const merchantTransactionId = req.query.id;
    if (!merchantTransactionId) {
      return res.status(400).json({ error: "Transaction ID is required" });
    }

    const checksum = generateChecksum("", `/pg/v1/status/${MERCHANT_ID}/${merchantTransactionId}`);

    const response = await axios.get(
      `${MERCHANT_STATUS_URL}/${MERCHANT_ID}/${merchantTransactionId}`,
      {
        headers: {
          "accept": "application/json",
          "Content-Type": "application/json",
          "X-VERIFY": checksum,
          "X-MERCHANT-ID": MERCHANT_ID
        }
      }
    );

    if (response.data.success) {
      return res.redirect(successUrl);
    } else {
      return res.redirect(failureUrl);
    }
  } catch (error) {
    console.error("Error fetching payment status:", error.message);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

app.listen(8000, () => {
  console.log("Server is running on port 8000");
  console.log("PhonePe Configuration:", { merchantId: MERCHANT_ID, baseUrl: MERCHANT_BASE_URL });
});
