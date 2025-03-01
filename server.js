import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  cors({
    origin: "https://uwcindia.in",
    methods: ["GET", "POST"],
  })
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MERCHANT_ID = process.env.MERCHANT_ID || "M22PU06UWBZNO";
const MERCHANT_KEY =
  process.env.MERCHANT_KEY || "b3ac0315-843a-4560-9e49-118b67de175c";
const KEY_INDEX = 1;

const MERCHANT_BASE_URL =
  process.env.MERCHANT_BASE_URL ||
  "https://api.phonepe.com/apis/hermes/pg/v1/pay";
const MERCHANT_STATUS_URL =
  process.env.MERCHANT_STATUS_URL ||
  "https://api.phonepe.com/apis/hermes/pg/v1/status";

const successUrl = "https://backend-uwc.onrender.com/payment-success";
const failureUrl = "https://backend-uwc.onrender.com/payment-failed";

// ✅ Supabase Client Configuration
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ✅ Function to Generate PhonePe Checksum
const generateChecksum = (payload, endpoint) => {
  const string = payload + endpoint + MERCHANT_KEY;
  const sha256 = crypto.createHash("sha256").update(string).digest("hex");
  return sha256 + "###" + KEY_INDEX;
};

// ✅ Route: Create Order & Initiate Payment
app.post("/create-order", async (req, res) => {
  try {
    const { name, mobileNumber, amount, email, address, service_type } =
      req.body;
    if (!name || !mobileNumber || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const orderId = uuidv4();
    const paymentPayload = {
      merchantId: MERCHANT_ID,
      merchantUserId: name,
      mobileNumber,
      amount: Number(amount) * 100,
      currency: "INR",
      merchantTransactionId: orderId,
      redirectUrl: successUrl,
      redirectMode: "POST",
      paymentInstrument: { type: "PAY_PAGE" },
    };

    const payload = Buffer.from(JSON.stringify(paymentPayload)).toString(
      "base64"
    );
    const checksum = generateChecksum(payload, "/pg/v1/pay");

    const response = await axios.post(
      MERCHANT_BASE_URL,
      { request: payload },
      {
        headers: {
          accept: "application/json",
          "Content-Type": "application/json",
          "X-VERIFY": checksum,
        },
      }
    );

    if (response.data.success) {
      await supabase.from("orders").insert([
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

      return res.status(200).json({
        msg: "OK",
        url: response.data.data.instrumentResponse.redirectInfo.url,
      });
    } else {
      throw new Error(response.data.message || "Failed to initiate payment");
    }
  } catch (error) {
    console.error("Error in payment initiation:", error.message);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

// ✅ POST Route: Handle Payment Success
app.post("/payment-success", async (req, res) => {
  try {
    console.log("Request body:", req.body);
    console.log("Request query:", req.query);

    const merchantTransactionId =
      req.body.merchantTransactionId ||
      req.body.id ||
      req.body.transactionId ||
      req.query.id ||
      req.query.merchantTransactionId ||
      req.query.transactionId;

    if (!merchantTransactionId) {
      return res.status(400).json({ error: "Transaction ID is required" });
    }

    const checksum = generateChecksum(
      "",
      `/pg/v1/status/${MERCHANT_ID}/${merchantTransactionId}`
    );
    const response = await axios.get(
      `${MERCHANT_STATUS_URL}/${MERCHANT_ID}/${merchantTransactionId}`,
      {
        headers: {
          accept: "application/json",
          "Content-Type": "application/json",
          "X-VERIFY": checksum,
          "X-MERCHANT-ID": MERCHANT_ID,
        },
      }
    );

    if (response.data.success) {
      const paymentData = response.data.data;
      console.log("Payment Success:", paymentData);

      const { error } = await supabase
        .from("orders")
        .update({
          status: paymentData.state,
          transaction_id: paymentData.transactionId,
          payment_method: paymentData.paymentInstrument.type,
        })
        .eq("order_id", merchantTransactionId);

      if (error) {
        console.error("Supabase Error:", error.message);
      }

      return res.redirect(`/payment-success?order_id=${merchantTransactionId}`);
    } else {
      return res.redirect(failureUrl);
    }
  } catch (error) {
    console.error("Error fetching payment status:", error.message);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

// ✅ GET Route: Fetch Order Details
app.get("/order/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json(data);
  } catch (error) {
    console.error("Error fetching order details:", error.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(8000, () => {
  console.log("Server is running on port 8000");
});
