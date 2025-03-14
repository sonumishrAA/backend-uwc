import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";

const app = express();
const port = 8000; // Hardcoded port

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: "https://uwcindia.in" })); // Hardcoded frontend URL

// Supabase Configuration (Hardcoded)
const SUPABASE_URL = "https://pvtuhceijltezxhqibrv.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2dHVoY2Vpamx0ZXp4aHFpYnJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzk0Njk1MzMsImV4cCI6MjA1NTA0NTUzM30.kw49U2pX09mV9AjqqPMbipv2Dv6aSttqCXHhJQlmisY";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// PhonePe Configuration (Hardcoded)
const MERCHANT_ID = "M22PU06UWBZNO";
const PHONEPE_KEY = "b3ac0315-843a-4560-9e49-118b67de175c";
const KEY_INDEX = 1;
const BACKEND_URL = "https://backend-uwc.onrender.com"; // Hardcoded backend URL
const FRONTEND_SUCCESS_URL = "https://uwcindia.in/success"; // Hardcoded success URL
const FRONTEND_FAILURE_URL = "https://uwcindia.in/failure"; // Hardcoded failure URL


const PHONEPE_BASE_URL =
  PHONEPE_ENV ="https://api.phonepe.com/apis/hermes";

// Helper function: Generate checksum
const generateChecksum = (payload, endpoint) => {
  const string = Buffer.from(payload).toString("utf8") + endpoint + PHONEPE_KEY;
  return crypto.createHash("sha256").update(string).digest("hex") + "###" + KEY_INDEX;
};

// Create Order Endpoint
app.post("/create-order", async (req, res) => {
  try {
    const { name, mobileNumber, amount, email, address, service_type } = req.body;

    if (!name || !mobileNumber || !amount || !/^\d{10}$/.test(mobileNumber)) {
      return res.status(400).json({ error: "Invalid/Missing required fields" });
    }

    const orderId = uuidv4();
    const paymentPayload = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: orderId,
      merchantUserId: `USER_${mobileNumber.slice(-4)}`,
      amount: Math.round(Number(amount) * 100),
      currency: "INR",
      redirectUrl: `${BACKEND_URL}/payment-success`,
      redirectMode: "POST",
      mobileNumber: mobileNumber.toString(),
      paymentInstrument: { type: "PAY_PAGE" },
    };

    const base64Payload = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const checksum = generateChecksum(base64Payload, "/pg/v1/pay");

    const response = await axios.post(
      `${PHONEPE_BASE_URL}/pg/v1/pay`,
      { request: base64Payload },
      {
        headers: {
          "Content-Type": "application/json",
          "X-VERIFY": checksum,
          "X-CALLBACK-URL": `${BACKEND_URL}/payment-success`,
        },
        timeout: 10000,
      }
    );

    if (!response.data?.data?.instrumentResponse?.redirectInfo?.url) {
      throw new Error("Invalid response from payment gateway");
    }

    const { error } = await supabase.from("orders").insert([
      {
        order_id: orderId,
        name,
        email,
        phone_no: mobileNumber,
        address,
        service_type,
        amount: Number(amount),
        status: "PENDING",
        created_at: new Date().toISOString(),
      },
    ]);

    if (error) throw error;

    res.json({
      success: true,
      url: response.data.data.instrumentResponse.redirectInfo.url,
      orderId,
    });
  } catch (error) {
    console.error("Create Order Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Payment initiation failed", details: error.response?.data || error.message });
  }
});

// Payment Success Webhook
app.post("/payment-success", async (req, res) => {
  try {
    const { transactionId, merchantTransactionId } = req.body;
    const orderId = transactionId || merchantTransactionId || req.query.orderId;

    if (!orderId) {
      return res.redirect(`${FRONTEND_FAILURE_URL}?error=missing_order_id`);
    }

    const statusEndpoint = `/pg/v1/status/${MERCHANT_ID}/${orderId}`;
    const checksum = generateChecksum("", statusEndpoint);

    const statusResponse = await axios.get(`${PHONEPE_BASE_URL}${statusEndpoint}`, {
      headers: {
        "X-VERIFY": checksum,
        "X-MERCHANT-ID": MERCHANT_ID,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });

    if (statusResponse.data?.success) {
      const paymentData = statusResponse.data.data;

      const { error } = await supabase
        .from("orders")
        .update({
          status: paymentData.state,
          transaction_id: paymentData.transactionId,
          payment_method: paymentData.paymentInstrument?.type || "UNKNOWN",
          updated_at: new Date().toISOString(),
        })
        .eq("order_id", orderId);

      return res.redirect(`${FRONTEND_SUCCESS_URL}/${orderId}`);
    }

    res.redirect(FRONTEND_FAILURE_URL);
  } catch (error) {
    console.error("Payment Verification Error:", error.response?.data || error.message);
    res.redirect(`${FRONTEND_FAILURE_URL}?error=verification_failed`);
  }
});

// Order Status Check
app.get("/order/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from("orders").select("*").eq("order_id", id).single();

    if (error || !data) throw new Error("Order not found");
    res.json(data);
  } catch (error) {
    console.error("Order Fetch Error:", error);
    res.status(404).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
