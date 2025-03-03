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

const FRONTEND_SUCCESS_URL = "https://backend-uwc.onrender.com/payment-success";
const FRONTEND_FAILURE_URL = "https://backend-uwc.onrender.com/payment-failed";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const generateChecksum = (payload, endpoint) => {
  const string = payload + endpoint + MERCHANT_KEY;
  const sha256 = crypto.createHash("sha256").update(string).digest("hex");
  return sha256 + "###" + KEY_INDEX;
};

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
      redirectUrl: "https://backend-uwc.onrender.com/payment-success",
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

      return res.status(200).json({
        msg: "OK",
        url: response.data.data.instrumentResponse.redirectInfo.url,
      });
    }
    throw new Error(response.data.message || "Payment initiation failed");
  } catch (error) {
    console.error("Create Order Error:", error);
    return res.status(500).json({ error: error.message });
  }
});

app.post("/payment-success", async (req, res) => {
  try {
    const merchantTransactionId =
      req.body.transactionId || req.body.merchantTransactionId || req.query.id;

    if (!merchantTransactionId) {
      return res.redirect(`${FRONTEND_FAILURE_URL}?error=missing_transaction_id`);
    }

    const checksum = generateChecksum(
      "",
      `/pg/v1/status/${MERCHANT_ID}/${merchantTransactionId}`
    );

    const statusResponse = await axios.get(
      `${MERCHANT_STATUS_URL}/${MERCHANT_ID}/${merchantTransactionId}`,
      {
        headers: {
          "X-VERIFY": checksum,
          "X-MERCHANT-ID": MERCHANT_ID,
        },
      }
    );

    if (statusResponse.data.success) {
      const paymentData = statusResponse.data.data;

      const { data: existingOrder } = await supabase
        .from("orders")
        .select("*")
        .eq("order_id", merchantTransactionId)
        .single();

      const updateData = {
        status: paymentData.state,
        transaction_id: paymentData.transactionId,
        payment_method: paymentData.paymentInstrument.type,
      };

      // Only add service_type if it's missing
      if (!existingOrder?.service_type && req.body.service_type) {
        updateData.service_type = req.body.service_type;
      }

      // Add updated_at only after creating the column
      // updateData.updated_at = new Date().toISOString();

      const { error } = await supabase
        .from("orders")
        .update(updateData)
        .eq("order_id", merchantTransactionId);

      if (error) throw error;

      return res.redirect(`${FRONTEND_SUCCESS_URL}/${merchantTransactionId}`);
    }
    return res.redirect(FRONTEND_FAILURE_URL);
  } catch (error) {
    console.error("Payment Success Error:", error);
    return res.redirect(
      `${FRONTEND_FAILURE_URL}?error=${encodeURIComponent(error.message)}`
    );
  }
});
app.get("/order/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", id)
      .single();

    if (error || !data) throw new Error("Order not found");
    res.json(data);
  } catch (error) {
    console.error("Order Fetch Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(8000, () => {
  console.log("Server running on port 8000");
});
