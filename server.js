import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Configuration
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(cors({ origin: "https://uwcindia.in", methods: ["GET", "POST"] }));

// PhonePe Constants
const MERCHANT_ID = process.env.MERCHANT_ID || "M22PU06UWBZNO";
const MERCHANT_KEY = process.env.MERCHANT_KEY || "b3ac0315-843a-4560-9e49-118b67de175c";
const KEY_INDEX = 1;
const MERCHANT_BASE_URL = "https://api.phonepe.com/apis/hermes/pg/v1/pay";
const MERCHANT_STATUS_URL = "https://api.phonepe.com/apis/hermes/pg/v1/status";

// Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Helper Functions
const generateChecksum = (payload, endpoint) => {
  const string = payload + endpoint + MERCHANT_KEY;
  return crypto.createHash("sha256").update(string).digest("hex") + "###" + KEY_INDEX;
};

// Routes
app.post("/create-order", async (req, res) => {
  try {
    const { name, mobileNumber, amount } = req.body;
    if (!name || !mobileNumber || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const transactionId = uuidv4();
    const paymentPayload = {
      merchantId: MERCHANT_ID,
      merchantUserId: name,
      mobileNumber,
      amount: Number(amount) * 100,
      currency: "INR",
      merchantTransactionId: transactionId,
      redirectUrl: "https://backend-uwc.onrender.com/payment-success",
      redirectMode: "POST",
      paymentInstrument: { type: "PAY_PAGE" },
    };

    const payloadBase64 = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const checksum = generateChecksum(payloadBase64, "/pg/v1/pay");

    const response = await axios.post(MERCHANT_BASE_URL, { request: payloadBase64 }, {
      headers: {
        "Content-Type": "application/json",
        "X-VERIFY": checksum,
      }
    });

    res.json({
      success: true,
      paymentUrl: response.data.data.instrumentResponse.redirectInfo.url
    });

  } catch (error) {
    console.error("Create Order Error:", error);
    res.status(500).json({ error: "Payment initiation failed" });
  }
});

app.post("/payment-success", async (req, res) => {
  try {
    // Decode PhonePe's response
    const base64Response = req.body.response;
    if (!base64Response) throw new Error("No response data");
    
    const decodedResponse = JSON.parse(
      Buffer.from(base64Response, "base64").toString("utf-8")
    );
    
    const transactionId = decodedResponse.data.merchantTransactionId;
    if (!transactionId) throw new Error("Transaction ID missing");

    // Verify payment status
    const checksum = generateChecksum("", `/pg/v1/status/${MERCHANT_ID}/${transactionId}`);
    const statusResponse = await axios.get(
      `${MERCHANT_STATUS_URL}/${MERCHANT_ID}/${transactionId}`,
      { headers: { "X-VERIFY": checksum, "X-MERCHANT-ID": MERCHANT_ID } }
    );

    if (statusResponse.data.success) {
      // Save to database
      const paymentData = statusResponse.data.data;
      const { error } = await supabase.from("payments").insert([{
        order_id: transactionId,
        amount: paymentData.amount / 100,
        status: paymentData.state,
        transaction_id: paymentData.transactionId,
        payment_method: paymentData.paymentInstrument.type,
        created_at: new Date().toISOString(),
      }]);

      if (error) throw error;

      // Redirect to success page
      res.redirect(`/payment-success.html?transaction_id=${transactionId}`);
    } else {
      res.redirect("/payment-failed.html");
    }

  } catch (error) {
    console.error("Payment Callback Error:", error);
    res.redirect("/payment-failed.html");
  }
});

// Support Routes
app.get("/order/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("payments")
      .select("*")
      .eq("order_id", req.params.id)
      .single();

    if (error || !data) throw new Error("Order not found");
    res.json(data);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

// HTML Pages
app.get("/payment-success.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "payment-success.html"));
});

app.get("/payment-failed.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "payment-failed.html"));
});

// Server Start
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
