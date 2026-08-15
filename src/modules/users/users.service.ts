import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { User, UserDocument } from './schemas/user.schema';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
  ) {}

  async findAll(): Promise<UserDocument[]> {
    return this.userModel.find().exec();
  }

  async findByNationalId(nationalId: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ nationalId }).exec();
  }

  async findByPhoneNumber(
    phoneNumber: string,
  ): Promise<UserDocument | null> {
    return this.userModel.findOne({ phoneNumber }).exec();
  }
}