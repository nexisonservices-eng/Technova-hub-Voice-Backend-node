import mongoose from 'mongoose';

const outboundLocalTemplateSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 80
    },
    script: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

outboundLocalTemplateSchema.index({ createdBy: 1, updatedAt: -1 });

const OutboundLocalTemplate = mongoose.model(
  'OutboundLocalTemplate',
  outboundLocalTemplateSchema,
  'outboundlocaltemplates'
);
export default OutboundLocalTemplate;


